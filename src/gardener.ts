/**
 * Memory Gardener: deterministic (non-model) checks over already-materialized claims that surface
 * contradictions, duplicates, expirations, and orphaned evidence as reviewable proposals. Never
 * rewrites an accepted claim in place — every finding becomes a proposal (plan §12).
 *
 * Reduced scope (documented in IMPLEMENTATION_NOTES.md): "dormant condition satisfied" and
 * "rejected proposal regenerated without new evidence" are not separate checks here — the latter is
 * already covered globally by fingerprint suppression (repositories/review.ts).
 */
import { canonicalize, fingerprint } from "./ids.ts";
import { getDb } from "./db.ts";
import { provenanceForCreatedFromArtifact } from "./provenance.ts";
import { createProposal, isFingerprintSuppressed } from "./repositories/review.ts";
import type { ThreadkeeperConfig } from "./config.ts";
import type { ClaimRow, ConfidenceComponents } from "./types.ts";

const SCAN_LIMIT = 500;

function confidence(evidenceQuality: number, contradictionPenalty: number, risk: "low" | "medium" | "high"): ConfidenceComponents {
  return { extraction: 1, evidence_quality: evidenceQuality, source_independence: 1, recency: 0, user_confirmation: 0, contradiction_penalty: contradictionPenalty, risk };
}

export interface GardenerSummary {
  proposalsCreated: number;
}

export function runGardenerSweep(config: ThreadkeeperConfig, now = Date.now()): GardenerSummary {
  const db = getDb();
  let proposalsCreated = 0;
  const cooldown = config.serendipity.dismissalCooldownDays;

  function propose(
    proposalType: "mark_historical" | "merge_duplicates",
    claim: ClaimRow,
    reason: string,
    payload: Record<string, unknown>,
    confidenceComponents: ConfidenceComponents,
  ): void {
    const fp = fingerprint({ op: proposalType, claimId: claim.id, reason });
    if (isFingerprintSuppressed(db, fp, cooldown, now)) return;
    const { created } = createProposal(
      db,
      {
        proposalType,
        targetType: "claim",
        targetId: claim.id,
        operation: proposalType,
        payload: { claimId: claim.id, reason, ...payload },
        fingerprint: fp,
        confidence: confidenceComponents,
        createdByRunId: null,
        expiresAt: null,
      },
      now,
    );
    if (created) proposalsCreated++;
  }

  // ── Contradictory / duplicate active claims for the same (subject, predicate) ──
  const groups = db
    .query(`SELECT subject, predicate FROM claims WHERE status = 'active' GROUP BY subject, predicate HAVING COUNT(*) > 1 LIMIT ?`)
    .all(SCAN_LIMIT) as Array<{ subject: string; predicate: string }>;
  for (const group of groups) {
    const rows = db
      .query(`SELECT * FROM claims WHERE subject = ? AND predicate = ? AND status = 'active' ORDER BY created_at ASC`)
      .all(group.subject, group.predicate) as ClaimRow[];
    const newest = rows[rows.length - 1]!;
    for (const older of rows.slice(0, -1)) {
      const duplicate = canonicalize(JSON.parse(older.object_json)) === canonicalize(JSON.parse(newest.object_json));
      if (duplicate) {
        propose("merge_duplicates", older, "duplicate active claim", { keptClaimId: newest.id }, confidence(0.7, 0, "medium"));
      } else {
        propose("mark_historical", older, "contradictory active claim", { supersededByClaimId: newest.id }, confidence(0.6, 0.4, "medium"));
      }
    }
  }

  // ── Temporal expiration ──
  const expired = db.query(`SELECT * FROM claims WHERE status = 'active' AND valid_to IS NOT NULL AND valid_to < ? LIMIT ?`).all(now, SCAN_LIMIT) as ClaimRow[];
  for (const claim of expired) {
    propose("mark_historical", claim, "validity window expired", {}, confidence(0.8, 0, "low"));
  }

  // ── Claims whose only supporting evidence has since been deleted ──
  const active = db.query(`SELECT * FROM claims WHERE status = 'active' LIMIT ?`).all(SCAN_LIMIT) as ClaimRow[];
  for (const claim of active) {
    if (!claim.created_from_artifact_id) continue;
    if (provenanceForCreatedFromArtifact(claim.created_from_artifact_id).length === 0) {
      propose("mark_historical", claim, "all supporting evidence was deleted", {}, confidence(0.2, 0.5, "medium"));
    }
  }

  return { proposalsCreated };
}
