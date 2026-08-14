/**
 * Deletion propagation for `conversation-deleted` and `conversations-cleared`. Idempotent and
 * safe to repeat — every worker checks tombstones before committing, so a stale in-flight job can
 * never resurrect deleted content (plan §16). No model calls: bounded SQLite work plus best-effort
 * private-index removal only.
 */
import type { Database } from "bun:sqlite";
import { getDb } from "./db.ts";
import { fingerprint } from "./ids.ts";
import { removeOwnerDocument } from "./index-doc.ts";
import { markTombstonePurged, recordAudit, tombstone } from "./repositories/audit.ts";
import { deleteSourcesForConversation, getEvidenceForArtifact } from "./repositories/evidence.ts";
import { clearCursor, clearDirty, deleteJobsForConversation } from "./repositories/queue.ts";
import { createProposal, isFingerprintSuppressed } from "./repositories/review.ts";
import type { ClaimRow } from "./types.ts";

function artifactsTouchedByConversation(db: Database, conversationId: string): string[] {
  return (
    db
      .query(
        `SELECT DISTINCT e.artifact_id as id FROM evidence_edges e
         JOIN source_revisions r ON r.id = e.source_revision_id
         JOIN sources s ON s.id = r.source_id
         WHERE s.conversation_id = ?`,
      )
      .all(conversationId) as Array<{ id: string }>
  ).map((r) => r.id);
}

function threadsTouchedByConversation(db: Database, conversationId: string): string[] {
  return (
    db.query(`SELECT thread_id FROM thread_memberships WHERE object_type = 'conversation' AND object_id = ?`).all(conversationId) as Array<{
      thread_id: string;
    }>
  ).map((r) => r.thread_id);
}

function remainingEvidenceCount(db: Database, artifactId: string): number {
  const row = db.query(`SELECT COUNT(*) as n FROM evidence_edges WHERE artifact_id = ?`).get(artifactId) as { n: number };
  return row.n;
}

function threadHasAnyEvidence(db: Database, threadId: string): boolean {
  const artifactIds = (
    db.query(`SELECT object_id FROM thread_memberships WHERE thread_id = ? AND object_type = 'artifact'`).all(threadId) as Array<{ object_id: string }>
  ).map((r) => r.object_id);
  return artifactIds.some((id) => remainingEvidenceCount(db, id) > 0);
}

/** Cleanup for one deleted conversation. Idempotent — repeated calls for the same id are safe no-ops. */
export async function handleConversationDeleted(conversationId: string, now = Date.now()): Promise<void> {
  const db = getDb();
  const deletionGeneration = tombstone(db, "conversation", conversationId, now);

  const touchedArtifactIds = artifactsTouchedByConversation(db, conversationId);
  const touchedThreadIds = threadsTouchedByConversation(db, conversationId);

  deleteSourcesForConversation(db, conversationId); // cascades source_revisions + evidence_edges

  // Reject pending proposals whose run's evidence is now entirely gone.
  const orphanedArtifactIds = touchedArtifactIds.filter((id) => remainingEvidenceCount(db, id) === 0);
  if (orphanedArtifactIds.length > 0) {
    const placeholders = orphanedArtifactIds.map(() => "?").join(",");
    const runIds = new Set(
      (db.query(`SELECT DISTINCT run_id FROM artifacts WHERE id IN (${placeholders})`).all(...orphanedArtifactIds) as Array<{ run_id: string }>).map(
        (r) => r.run_id,
      ),
    );
    for (const runId of runIds) {
      const artifactsForRun = db.query(`SELECT id FROM artifacts WHERE run_id = ?`).all(runId) as Array<{ id: string }>;
      const allOrphaned = artifactsForRun.every((a) => remainingEvidenceCount(db, a.id) === 0);
      if (allOrphaned) {
        db.query(`UPDATE proposals SET status = 'rejected', reviewed_at = ?, rejection_reason = 'source_deleted' WHERE created_by_run_id = ? AND status = 'pending'`).run(
          now,
          runId,
        );
      }
    }

    // Re-evaluate accepted claims that now rest on zero evidence: propose marking them historical
    // (never an automatic in-place rewrite — plan §12 treats this as a Gardener-style proposal).
    const placeholders2 = orphanedArtifactIds.map(() => "?").join(",");
    const affectedClaims = db.query(`SELECT * FROM claims WHERE status = 'active' AND created_from_artifact_id IN (${placeholders2})`).all(
      ...orphanedArtifactIds,
    ) as ClaimRow[];
    for (const claim of affectedClaims) {
      const fp = fingerprint({ op: "mark_historical", claimId: claim.id, reason: "orphaned_evidence" });
      if (isFingerprintSuppressed(db, fp, 0, now)) continue;
      createProposal(
        db,
        {
          proposalType: "mark_historical",
          targetType: "claim",
          targetId: claim.id,
          operation: "mark_historical",
          payload: { claimId: claim.id, reason: "all supporting evidence was deleted" },
          fingerprint: fp,
          confidence: { extraction: 1, evidence_quality: 0.1, source_independence: 0, recency: 0, user_confirmation: 0, contradiction_penalty: 0.5, risk: "medium" },
          createdByRunId: null,
          expiresAt: null,
        },
        now,
      );
    }
  }

  // Remove private-index documents for threads this conversation was the sole remaining evidence for.
  for (const threadId of touchedThreadIds) {
    if (!threadHasAnyEvidence(db, threadId)) await removeOwnerDocument("thread", threadId);
  }

  clearDirty(db, conversationId);
  clearCursor(db, conversationId);
  deleteJobsForConversation(db, conversationId);
  recordAudit(db, "conversation_deleted_cleanup", "conversation", conversationId, null, { touchedArtifacts: touchedArtifactIds.length }, now);
  markTombstonePurged(db, "conversation", conversationId, deletionGeneration);
}

/** Full conversation-derived-state purge for the dev-only `conversations-cleared` event. Idempotent. */
export async function handleConversationsCleared(now = Date.now()): Promise<void> {
  const db = getDb();
  const indexRows = db.query(`SELECT document_id FROM index_documents`).all() as Array<{ document_id: string }>;

  db.transaction(() => {
    db.exec(`DELETE FROM connections`);
    db.exec(`DELETE FROM proposals`);
    db.exec(`DELETE FROM thread_memberships`);
    db.exec(`DELETE FROM open_loops`);
    db.exec(`DELETE FROM events`);
    db.exec(`DELETE FROM claims`);
    db.exec(`DELETE FROM threads`);
    db.exec(`DELETE FROM pipeline_runs`); // cascades artifacts + evidence_edges
    db.exec(`DELETE FROM sources`); // cascades source_revisions
    db.exec(`DELETE FROM dirty_conversations`);
    db.exec(`DELETE FROM conversation_cursors`);
    db.exec(`DELETE FROM jobs`);
    db.exec(`DELETE FROM index_documents`);
  })();

  for (const row of indexRows) {
    try {
      const [ownerType, ownerId] = row.document_id.split(":");
      if (ownerType && ownerId) await removeOwnerDocument(ownerType, ownerId);
    } catch {
      // Best-effort; the ledger row is already gone from the transaction above.
    }
  }

  recordAudit(db, "conversations_cleared", null, null, null, { indexDocumentsRemoved: indexRows.length }, now);
}
