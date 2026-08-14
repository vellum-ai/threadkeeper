import type { Database } from "bun:sqlite";
import { newId } from "../ids.ts";
import type { JobKind, JobRow, JobStatus } from "../types.ts";

// ─── dirty_conversations: the fast live-capture queue ───────────────────────

export function markDirty(db: Database, conversationId: string, requestId: string | null, now = Date.now()): void {
  db.query(
    `INSERT INTO dirty_conversations(conversation_id, touched_at, request_id)
     VALUES (?, ?, ?)
     ON CONFLICT(conversation_id) DO UPDATE SET
       touched_at = excluded.touched_at,
       request_id = excluded.request_id`,
  ).run(conversationId, now, requestId);
}

export interface DirtyRow {
  conversation_id: string;
  touched_at: number;
  request_id: string | null;
  attempts: number;
  next_attempt_at: number | null;
  last_error_code: string | null;
}

/** Claim up to `limit` dirty conversations that are not backing off. Ordered oldest-touched first. */
export function claimDirtyBatch(db: Database, limit: number, now = Date.now()): DirtyRow[] {
  return db
    .query(
      `SELECT * FROM dirty_conversations
       WHERE next_attempt_at IS NULL OR next_attempt_at <= ?
       ORDER BY touched_at ASC LIMIT ?`,
    )
    .all(now, limit) as DirtyRow[];
}

export function clearDirty(db: Database, conversationId: string): void {
  db.query(`DELETE FROM dirty_conversations WHERE conversation_id = ?`).run(conversationId);
}

const RETRY_BACKOFF_MS = [30_000, 120_000, 600_000, 1_800_000];

export function markDirtyRetry(db: Database, conversationId: string, errorCode: string, now = Date.now()): void {
  const row = db
    .query(`SELECT attempts FROM dirty_conversations WHERE conversation_id = ?`)
    .get(conversationId) as { attempts: number } | null;
  const attempts = (row?.attempts ?? 0) + 1;
  const backoff = RETRY_BACKOFF_MS[Math.min(attempts - 1, RETRY_BACKOFF_MS.length - 1)]!;
  db.query(
    `UPDATE dirty_conversations SET attempts = ?, next_attempt_at = ?, last_error_code = ? WHERE conversation_id = ?`,
  ).run(attempts, now + backoff, errorCode, conversationId);
}

export function getDirtyStats(db: Database, now = Date.now()): { count: number; oldestAgeMs: number | null } {
  const countRow = db.query(`SELECT COUNT(*) as n FROM dirty_conversations`).get() as { n: number };
  const oldestRow = db.query(`SELECT MIN(touched_at) as t FROM dirty_conversations`).get() as { t: number | null };
  return { count: countRow.n, oldestAgeMs: oldestRow.t == null ? null : now - oldestRow.t };
}

// ─── conversation_cursors ────────────────────────────────────────────────────

export interface CursorRow {
  conversation_id: string;
  last_processed_message_id: string | null;
  last_processed_at: number | null;
  last_seen_at: number;
  full_rescan_required: number;
}

export function getCursor(db: Database, conversationId: string): CursorRow | null {
  return db.query(`SELECT * FROM conversation_cursors WHERE conversation_id = ?`).get(conversationId) as
    | CursorRow
    | null;
}

export function touchCursorSeen(db: Database, conversationId: string, now = Date.now()): void {
  db.query(
    `INSERT INTO conversation_cursors(conversation_id, last_seen_at, full_rescan_required)
     VALUES (?, ?, 0)
     ON CONFLICT(conversation_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
  ).run(conversationId, now);
}

export function setFullRescanRequired(db: Database, conversationId: string, now = Date.now()): void {
  db.query(
    `INSERT INTO conversation_cursors(conversation_id, last_seen_at, full_rescan_required)
     VALUES (?, ?, 1)
     ON CONFLICT(conversation_id) DO UPDATE SET full_rescan_required = 1, last_seen_at = excluded.last_seen_at`,
  ).run(conversationId, now);
}

/** Only called after the artifacts for the ingested batch have committed. */
export function advanceCursor(
  db: Database,
  conversationId: string,
  lastProcessedMessageId: string,
  now = Date.now(),
): void {
  db.query(
    `INSERT INTO conversation_cursors(conversation_id, last_processed_message_id, last_processed_at, last_seen_at, full_rescan_required)
     VALUES (?, ?, ?, ?, 0)
     ON CONFLICT(conversation_id) DO UPDATE SET
       last_processed_message_id = excluded.last_processed_message_id,
       last_processed_at = excluded.last_processed_at,
       last_seen_at = excluded.last_seen_at,
       full_rescan_required = 0`,
  ).run(conversationId, lastProcessedMessageId, now, now);
}

export function clearCursor(db: Database, conversationId: string): void {
  db.query(`DELETE FROM conversation_cursors WHERE conversation_id = ?`).run(conversationId);
}

// ─── jobs: bounded leased queue for deep/background work ───────────────────

export interface CreateJobInput {
  jobType: JobKind;
  input: unknown;
  idempotencyKey: string;
  maxAttempts?: number;
}

export type ParsedJob = JobRow & { input: unknown; output: unknown };

function parseJobRow(row: JobRow): ParsedJob {
  return { ...row, input: JSON.parse(row.input_json), output: row.output_json ? JSON.parse(row.output_json) : null };
}

/** Insert a job, or return the existing one if the idempotency key already exists (dedupe). */
export function createJob(db: Database, params: CreateJobInput, now = Date.now()): ParsedJob {
  const id = newId();
  db.query(
    `INSERT INTO jobs(id, job_type, input_json, idempotency_key, status, attempts, max_attempts, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?)
     ON CONFLICT(idempotency_key) DO NOTHING`,
  ).run(id, params.jobType, JSON.stringify(params.input), params.idempotencyKey, params.maxAttempts ?? 3, now, now);
  const row = db.query(`SELECT * FROM jobs WHERE idempotency_key = ?`).get(params.idempotencyKey) as JobRow;
  return parseJobRow(row);
}

export function getJob(db: Database, id: string): ParsedJob | null {
  const row = db.query(`SELECT * FROM jobs WHERE id = ?`).get(id) as JobRow | null;
  return row ? parseJobRow(row) : null;
}

/** Claim up to `limit` pending/expired-lease jobs, marking them running with a short lease. */
export function claimJobs(
  db: Database,
  leaseMs: number,
  limit: number,
  jobType?: JobKind,
  now = Date.now(),
): Array<ParsedJob> {
  const candidates = (
    jobType
      ? db
          .query(
            `SELECT id FROM jobs
             WHERE job_type = ? AND status IN ('pending','running')
               AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
               AND (lease_until IS NULL OR lease_until <= ?)
             ORDER BY created_at ASC LIMIT ?`,
          )
          .all(jobType, now, now, limit)
      : db
          .query(
            `SELECT id FROM jobs
             WHERE status IN ('pending','running')
               AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
               AND (lease_until IS NULL OR lease_until <= ?)
             ORDER BY created_at ASC LIMIT ?`,
          )
          .all(now, now, limit)
  ) as Array<{ id: string }>;
  const claimed: Array<ParsedJob> = [];
  for (const { id } of candidates) {
    db.query(`UPDATE jobs SET status = 'running', lease_until = ?, attempts = attempts + 1, updated_at = ? WHERE id = ?`).run(
      now + leaseMs,
      now,
      id,
    );
    const row = db.query(`SELECT * FROM jobs WHERE id = ?`).get(id) as JobRow;
    claimed.push(parseJobRow(row));
  }
  return claimed;
}

/** Job still owns its lease and hasn't been reclaimed by another worker since it was claimed. */
export function jobOwnsLease(db: Database, id: string, now = Date.now()): boolean {
  const row = db.query(`SELECT lease_until, status FROM jobs WHERE id = ?`).get(id) as
    | { lease_until: number | null; status: JobStatus }
    | null;
  return !!row && row.status === "running" && row.lease_until != null && row.lease_until > now;
}

export function completeJob(db: Database, id: string, output: unknown, now = Date.now()): void {
  db.query(`UPDATE jobs SET status = 'succeeded', lease_until = NULL, output_json = ?, updated_at = ? WHERE id = ?`).run(
    output === undefined ? null : JSON.stringify(output),
    now,
    id,
  );
}

const JOB_BACKOFF_MS = [15_000, 60_000, 300_000];

export function failJob(db: Database, id: string, errorCode: string, now = Date.now()): void {
  const row = db.query(`SELECT attempts, max_attempts FROM jobs WHERE id = ?`).get(id) as
    | { attempts: number; max_attempts: number }
    | null;
  if (!row) return;
  if (row.attempts >= row.max_attempts) {
    db.query(`UPDATE jobs SET status = 'failed', lease_until = NULL, last_error_code = ?, updated_at = ? WHERE id = ?`).run(
      errorCode,
      now,
      id,
    );
    return;
  }
  const backoff = JOB_BACKOFF_MS[Math.min(row.attempts - 1, JOB_BACKOFF_MS.length - 1)]!;
  db.query(
    `UPDATE jobs SET status = 'pending', lease_until = NULL, next_attempt_at = ?, last_error_code = ?, updated_at = ? WHERE id = ?`,
  ).run(now + backoff, errorCode, now, id);
}

export function listJobsByStatus(db: Database): Record<JobStatus, number> {
  const rows = db.query(`SELECT status, COUNT(*) as n FROM jobs GROUP BY status`).all() as Array<{
    status: JobStatus;
    n: number;
  }>;
  const out: Record<JobStatus, number> = { pending: 0, running: 0, succeeded: 0, failed: 0 };
  for (const row of rows) out[row.status] = row.n;
  return out;
}

export function deleteJobsForConversation(db: Database, conversationId: string): void {
  db.query(`DELETE FROM jobs WHERE input_json LIKE ?`).run(`%${conversationId}%`);
}
