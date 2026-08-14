import type { Database } from "bun:sqlite";
import { newId } from "../ids.ts";
import type {
  ConfidenceComponents,
  ConnectionRow,
  ConnectionType,
  ProposalRow,
  ProposalType,
  ScoreComponents,
} from "../types.ts";

// ─── proposals ───────────────────────────────────────────────────────────────

export interface CreateProposalInput {
  proposalType: ProposalType;
  targetType: string | null;
  targetId: string | null;
  operation: string;
  payload: unknown;
  fingerprint: string;
  confidence: ConfidenceComponents;
  createdByRunId: string | null;
  expiresAt: number | null;
}

/** Returns {created:false} without writing when the fingerprint already exists (dedupe, not just suppression). */
export function createProposal(db: Database, input: CreateProposalInput, now = Date.now()): { row: ProposalRow; created: boolean } {
  const existing = db.query(`SELECT * FROM proposals WHERE fingerprint = ?`).get(input.fingerprint) as ProposalRow | null;
  if (existing) return { row: existing, created: false };
  const id = newId();
  db.query(
    `INSERT INTO proposals(id, proposal_type, target_type, target_id, operation, proposed_payload_json, status, fingerprint, confidence_json, created_by_run_id, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.proposalType,
    input.targetType,
    input.targetId,
    input.operation,
    JSON.stringify(input.payload),
    input.fingerprint,
    JSON.stringify(input.confidence),
    input.createdByRunId,
    now,
    input.expiresAt,
  );
  return { row: db.query(`SELECT * FROM proposals WHERE id = ?`).get(id) as ProposalRow, created: true };
}

export function getProposal(db: Database, id: string): ProposalRow | null {
  return db.query(`SELECT * FROM proposals WHERE id = ?`).get(id) as ProposalRow | null;
}

export function listProposals(db: Database, status: string, limit: number): ProposalRow[] {
  if (status === "all") return db.query(`SELECT * FROM proposals ORDER BY created_at DESC LIMIT ?`).all(limit) as ProposalRow[];
  return db.query(`SELECT * FROM proposals WHERE status = ? ORDER BY created_at DESC LIMIT ?`).all(status, limit) as ProposalRow[];
}

export function reviewProposal(db: Database, id: string, status: "accepted" | "rejected", reason: string | null, now = Date.now()): void {
  db.query(`UPDATE proposals SET status = ?, reviewed_at = ?, rejection_reason = ? WHERE id = ?`).run(status, now, reason, id);
}

// ─── connections ─────────────────────────────────────────────────────────────

export interface CreateConnectionInput {
  fromType: string;
  fromId: string;
  toType: string;
  toId: string;
  relationType: ConnectionType;
  explanation: string;
  score: ScoreComponents;
  fingerprint: string;
  createdByRunId: string | null;
  expiresAt: number | null;
}

export function createConnection(db: Database, input: CreateConnectionInput, now = Date.now()): { row: ConnectionRow; created: boolean } {
  const existing = db.query(`SELECT * FROM connections WHERE fingerprint = ?`).get(input.fingerprint) as ConnectionRow | null;
  if (existing) return { row: existing, created: false };
  const id = newId();
  db.query(
    `INSERT INTO connections(id, from_type, from_id, to_type, to_id, relation_type, explanation, score_json, status, fingerprint, created_by_run_id, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
  ).run(
    id,
    input.fromType,
    input.fromId,
    input.toType,
    input.toId,
    input.relationType,
    input.explanation,
    JSON.stringify(input.score),
    input.fingerprint,
    input.createdByRunId,
    now,
    input.expiresAt,
  );
  return { row: db.query(`SELECT * FROM connections WHERE id = ?`).get(id) as ConnectionRow, created: true };
}

export function getConnection(db: Database, id: string): ConnectionRow | null {
  return db.query(`SELECT * FROM connections WHERE id = ?`).get(id) as ConnectionRow | null;
}

export function listConnections(db: Database, status: string, limit: number): ConnectionRow[] {
  if (status === "all") return db.query(`SELECT * FROM connections ORDER BY created_at DESC LIMIT ?`).all(limit) as ConnectionRow[];
  return db.query(`SELECT * FROM connections WHERE status = ? ORDER BY created_at DESC LIMIT ?`).all(status, limit) as ConnectionRow[];
}

export function setConnectionStatus(db: Database, id: string, status: string): void {
  db.query(`UPDATE connections SET status = ? WHERE id = ?`).run(status, id);
}

// ─── feedback + fingerprint suppression ─────────────────────────────────────

export function recordFeedback(db: Database, targetType: string, targetId: string, feedbackType: string, reason: string | null, now = Date.now()): void {
  const id = newId();
  db.query(`INSERT INTO feedback(id, target_type, target_id, feedback_type, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
    id,
    targetType,
    targetId,
    feedbackType,
    reason,
    now,
  );
}

/**
 * A fingerprint is suppressed if the proposal/connection carrying it was rejected/dismissed and no
 * cooldown has been given for a fresh attempt. Checked before creating a new proposal/connection so
 * a rejected suggestion never silently reappears without materially new evidence (a different fingerprint).
 */
export function isFingerprintSuppressed(db: Database, fingerprint: string, cooldownDays: number, now = Date.now()): boolean {
  const proposal = db
    .query(`SELECT reviewed_at FROM proposals WHERE fingerprint = ? AND status = 'rejected'`)
    .get(fingerprint) as { reviewed_at: number | null } | null;
  const connection = db
    .query(`SELECT created_at FROM connections WHERE fingerprint = ? AND status IN ('dismissed','wrong')`)
    .get(fingerprint) as { created_at: number } | null;
  const reviewedAt = proposal?.reviewed_at ?? (connection ? connection.created_at : null);
  if (reviewedAt == null) return false;
  const cooldownMs = cooldownDays * 24 * 60 * 60 * 1000;
  return now - reviewedAt < cooldownMs;
}
