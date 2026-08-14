import type { Database } from "bun:sqlite";
import { newId } from "../ids.ts";

// ─── tombstones ──────────────────────────────────────────────────────────────

/** Insert (or bump the generation of) a tombstone. Idempotent — repeated deletion is safe. */
export function tombstone(db: Database, targetType: string, targetId: string, now = Date.now()): number {
  const last = db
    .query(`SELECT MAX(deletion_generation) as g FROM tombstones WHERE target_type = ? AND target_id = ?`)
    .get(targetType, targetId) as { g: number | null };
  const generation = (last.g ?? 0) + 1;
  db.query(
    `INSERT INTO tombstones(target_type, target_id, deletion_generation, deleted_at, purge_status) VALUES (?, ?, ?, ?, 'pending')`,
  ).run(targetType, targetId, generation, now);
  return generation;
}

export function isTombstoned(db: Database, targetType: string, targetId: string): boolean {
  const row = db.query(`SELECT 1 FROM tombstones WHERE target_type = ? AND target_id = ? LIMIT 1`).get(targetType, targetId);
  return row != null;
}

export function markTombstonePurged(db: Database, targetType: string, targetId: string, generation: number): void {
  db.query(`UPDATE tombstones SET purge_status = 'purged' WHERE target_type = ? AND target_id = ? AND deletion_generation = ?`).run(
    targetType,
    targetId,
    generation,
  );
}

// ─── audit_events ────────────────────────────────────────────────────────────

export function recordAudit(
  db: Database,
  action: string,
  targetType: string | null,
  targetId: string | null,
  requestId: string | null,
  metadata: unknown,
  now = Date.now(),
): void {
  db.query(
    `INSERT INTO audit_events(id, action, target_type, target_id, request_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(newId(), action, targetType, targetId, requestId, metadata == null ? null : JSON.stringify(metadata), now);
}

// ─── index_documents (SQLite-side ledger of the private semantic index) ────

export function recordIndexDocument(db: Database, documentId: string, ownerType: string, ownerId: string, contentHash: string, now = Date.now()): void {
  db.query(
    `INSERT INTO index_documents(document_id, owner_type, owner_id, content_hash, indexed_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(document_id) DO UPDATE SET content_hash = excluded.content_hash, indexed_at = excluded.indexed_at`,
  ).run(documentId, ownerType, ownerId, contentHash, now);
}

export function removeIndexDocumentRecord(db: Database, documentId: string): void {
  db.query(`DELETE FROM index_documents WHERE document_id = ?`).run(documentId);
}

export interface IndexDocumentRow {
  document_id: string;
  owner_type: string;
  owner_id: string;
  content_hash: string;
  indexed_at: number;
}

export function listIndexDocuments(db: Database): IndexDocumentRow[] {
  return db.query(`SELECT * FROM index_documents`).all() as IndexDocumentRow[];
}

export function getIndexDocumentByOwner(db: Database, ownerType: string, ownerId: string): IndexDocumentRow | null {
  return db.query(`SELECT * FROM index_documents WHERE owner_type = ? AND owner_id = ?`).get(ownerType, ownerId) as
    | IndexDocumentRow
    | null;
}

export function countIndexDocuments(db: Database): number {
  const row = db.query(`SELECT COUNT(*) as n FROM index_documents`).get() as { n: number };
  return row.n;
}
