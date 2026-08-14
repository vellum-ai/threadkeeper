import type { Database } from "bun:sqlite";
import { lexicalSimilarity, newId, normalizeText } from "../ids.ts";
import type { ClaimRow, EventRow, OpenLoopRow, OpenLoopStatus, ThreadRow, ThreadStatus } from "../types.ts";

// ─── threads ─────────────────────────────────────────────────────────────────

export function findThreadByNormalizedTitle(db: Database, normalizedTitle: string): ThreadRow | null {
  return db.query(`SELECT * FROM threads WHERE normalized_title = ?`).get(normalizedTitle) as ThreadRow | null;
}

/** Layer 2 of thread resolution: best lexical match among active/dormant threads above `minScore`. */
export function findThreadByLexicalMatch(db: Database, title: string, minScore = 0.34): ThreadRow | null {
  const candidates = db
    .query(`SELECT * FROM threads WHERE status IN ('active','blocked','dormant')`)
    .all() as ThreadRow[];
  let best: { thread: ThreadRow; score: number } | null = null;
  for (const thread of candidates) {
    const score = lexicalSimilarity(title, thread.title);
    if (score >= minScore && (!best || score > best.score)) best = { thread, score };
  }
  return best?.thread ?? null;
}

export function createThread(db: Database, title: string, summary: string | null, now = Date.now()): ThreadRow {
  const id = newId();
  db.query(
    `INSERT INTO threads(id, title, normalized_title, summary, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?)`,
  ).run(id, title, normalizeText(title), summary, now, now);
  return db.query(`SELECT * FROM threads WHERE id = ?`).get(id) as ThreadRow;
}

export function touchThread(db: Database, id: string, now = Date.now()): void {
  db.query(`UPDATE threads SET updated_at = ? WHERE id = ?`).run(now, id);
}

export function getThread(db: Database, id: string): ThreadRow | null {
  return db.query(`SELECT * FROM threads WHERE id = ?`).get(id) as ThreadRow | null;
}

export function setThreadStatus(db: Database, id: string, status: ThreadStatus, now = Date.now()): void {
  db.query(`UPDATE threads SET status = ?, updated_at = ?, archived_at = CASE WHEN ? = 'archived' THEN ? ELSE archived_at END WHERE id = ?`).run(
    status,
    now,
    status,
    now,
    id,
  );
}

export function listThreads(db: Database, status: string, limit: number): ThreadRow[] {
  if (status === "all") return db.query(`SELECT * FROM threads ORDER BY updated_at DESC LIMIT ?`).all(limit) as ThreadRow[];
  return db.query(`SELECT * FROM threads WHERE status = ? ORDER BY updated_at DESC LIMIT ?`).all(status, limit) as ThreadRow[];
}

export function addThreadMembership(
  db: Database,
  threadId: string,
  objectType: string,
  objectId: string,
  membershipType: string,
  confidence: number | null,
): void {
  db.query(
    `INSERT INTO thread_memberships(thread_id, object_type, object_id, membership_type, confidence)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(thread_id, object_type, object_id) DO UPDATE SET membership_type = excluded.membership_type, confidence = excluded.confidence`,
  ).run(threadId, objectType, objectId, membershipType, confidence);
}

export interface ThreadMembershipRow {
  thread_id: string;
  object_type: string;
  object_id: string;
  membership_type: string;
  confidence: number | null;
}

export function listThreadMemberships(db: Database, threadId: string): ThreadMembershipRow[] {
  return db.query(`SELECT * FROM thread_memberships WHERE thread_id = ?`).all(threadId) as ThreadMembershipRow[];
}

/** True when any conversation-typed member of the thread matches one of the given conversation ids. */
export function threadHasConversationMember(db: Database, threadId: string, conversationIds: string[]): boolean {
  if (conversationIds.length === 0) return false;
  const placeholders = conversationIds.map(() => "?").join(",");
  const row = db
    .query(
      `SELECT 1 FROM thread_memberships WHERE thread_id = ? AND object_type = 'conversation' AND object_id IN (${placeholders}) LIMIT 1`,
    )
    .get(threadId, ...conversationIds);
  return row != null;
}

// ─── events ──────────────────────────────────────────────────────────────────

export interface InsertEventInput {
  threadId: string | null;
  eventType: string;
  title: string;
  description: string | null;
  occurredAt: number | null;
  status: string;
  createdFromArtifactId: string | null;
}

export function insertEvent(db: Database, input: InsertEventInput, now = Date.now()): EventRow {
  const id = newId();
  db.query(
    `INSERT INTO events(id, thread_id, event_type, title, description, occurred_at, status, created_from_artifact_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, input.threadId, input.eventType, input.title, input.description, input.occurredAt, input.status, input.createdFromArtifactId, now);
  return db.query(`SELECT * FROM events WHERE id = ?`).get(id) as EventRow;
}

export function listEventsForThread(db: Database, threadId: string): EventRow[] {
  return db.query(`SELECT * FROM events WHERE thread_id = ? ORDER BY occurred_at ASC, created_at ASC`).all(threadId) as EventRow[];
}

// ─── open_loops ──────────────────────────────────────────────────────────────

export interface InsertOpenLoopInput {
  threadId: string | null;
  description: string;
  nextAction: string | null;
  dueAt: number | null;
  originType: "direct" | "inferred";
  confidence: number | null;
  createdFromArtifactId: string | null;
}

export function insertOpenLoop(db: Database, input: InsertOpenLoopInput, now = Date.now()): OpenLoopRow {
  const id = newId();
  db.query(
    `INSERT INTO open_loops(id, thread_id, description, next_action, status, due_at, origin_type, confidence, created_from_artifact_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)`,
  ).run(id, input.threadId, input.description, input.nextAction, input.dueAt, input.originType, input.confidence, input.createdFromArtifactId, now, now);
  return db.query(`SELECT * FROM open_loops WHERE id = ?`).get(id) as OpenLoopRow;
}

export function findOpenLoopsForThread(db: Database, threadId: string, status?: OpenLoopStatus): OpenLoopRow[] {
  if (status) return db.query(`SELECT * FROM open_loops WHERE thread_id = ? AND status = ?`).all(threadId, status) as OpenLoopRow[];
  return db.query(`SELECT * FROM open_loops WHERE thread_id = ?`).all(threadId) as OpenLoopRow[];
}

export function getOpenLoop(db: Database, id: string): OpenLoopRow | null {
  return db.query(`SELECT * FROM open_loops WHERE id = ?`).get(id) as OpenLoopRow | null;
}

export function updateOpenLoop(
  db: Database,
  id: string,
  patch: Partial<Pick<OpenLoopRow, "description" | "next_action" | "due_at" | "status">>,
  now = Date.now(),
): void {
  const current = getOpenLoop(db, id);
  if (!current) return;
  db.query(`UPDATE open_loops SET description = ?, next_action = ?, due_at = ?, status = ?, updated_at = ? WHERE id = ?`).run(
    patch.description ?? current.description,
    patch.next_action ?? current.next_action,
    patch.due_at ?? current.due_at,
    patch.status ?? current.status,
    now,
    id,
  );
}

export function listOpenLoops(db: Database, status: string, limit: number): OpenLoopRow[] {
  if (status === "all") return db.query(`SELECT * FROM open_loops ORDER BY updated_at DESC LIMIT ?`).all(limit) as OpenLoopRow[];
  return db.query(`SELECT * FROM open_loops WHERE status = ? ORDER BY updated_at DESC LIMIT ?`).all(status, limit) as OpenLoopRow[];
}

// ─── claims ──────────────────────────────────────────────────────────────────

export interface InsertClaimInput {
  subject: string;
  predicate: string;
  object: unknown;
  epistemicType: string;
  validFrom: number | null;
  validTo: number | null;
  status: "active" | "historical";
  supersedesClaimId: string | null;
  createdFromArtifactId: string | null;
}

export function insertClaim(db: Database, input: InsertClaimInput, now = Date.now()): ClaimRow {
  const id = newId();
  db.query(
    `INSERT INTO claims(id, subject, predicate, object_json, epistemic_type, valid_from, valid_to, status, supersedes_claim_id, created_from_artifact_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.subject,
    input.predicate,
    JSON.stringify(input.object),
    input.epistemicType,
    input.validFrom,
    input.validTo,
    input.status,
    input.supersedesClaimId,
    input.createdFromArtifactId,
    now,
    now,
  );
  return db.query(`SELECT * FROM claims WHERE id = ?`).get(id) as ClaimRow;
}

export function findActiveClaim(db: Database, subject: string, predicate: string): ClaimRow | null {
  return db
    .query(`SELECT * FROM claims WHERE subject = ? AND predicate = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 1`)
    .get(subject, predicate) as ClaimRow | null;
}

export function getClaim(db: Database, id: string): ClaimRow | null {
  return db.query(`SELECT * FROM claims WHERE id = ?`).get(id) as ClaimRow | null;
}

export function setClaimStatus(db: Database, id: string, status: string, now = Date.now()): void {
  db.query(`UPDATE claims SET status = ?, updated_at = ? WHERE id = ?`).run(status, now, id);
}

export function listClaimsForSource(db: Database, createdFromArtifactId: string): ClaimRow[] {
  return db.query(`SELECT * FROM claims WHERE created_from_artifact_id = ?`).all(createdFromArtifactId) as ClaimRow[];
}
