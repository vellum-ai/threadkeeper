/**
 * Deterministic projection policy: turns a validated, persisted extraction run into threads,
 * events, open loops, claims, and proposals. This is where "direct vs inferred" and "conservative
 * by default" (plan §0.10, §10) are enforced — nothing here is itself a model call.
 *
 * Rule of thumb applied throughout: a direct, unambiguous, low-risk open-loop statement or
 * completion can materialize immediately. Everything else — every claim, every inferred open loop,
 * every ambiguous closure — becomes a proposal. Never silently overwrite an existing accepted
 * projection; a correction always becomes a new proposal that supersedes, not an in-place rewrite.
 */
import type { ExtractOutcome } from "./extraction.ts";
import { canonicalize, fingerprint, lexicalSimilarity, normalizeText } from "./ids.ts";
import {
  addThreadMembership,
  createThread,
  findThreadByLexicalMatch,
  findThreadByNormalizedTitle,
  findOpenLoopsForThread,
  insertEvent,
  insertOpenLoop,
  listOpenLoops,
  touchThread,
  updateOpenLoop,
  findActiveClaim,
} from "./repositories/projections.ts";
import { createProposal, isFingerprintSuppressed } from "./repositories/review.ts";
import type { ThreadkeeperConfig } from "./config.ts";
import { getDb } from "./db.ts";
import type { ConfidenceComponents, ThreadRow } from "./types.ts";

type OkExtraction = Extract<ExtractOutcome, { status: "ok" }>;

const DIRECT_CLOSE_SIMILARITY = 0.42;
const DIRECT_MATCH_SIMILARITY = 0.45;

function toEpochMs(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function confidenceOf(extraction: number, evidenceQuality: number, sourceIndependence: number, risk: "low" | "medium" | "high"): ConfidenceComponents {
  return {
    extraction,
    evidence_quality: evidenceQuality,
    source_independence: sourceIndependence,
    recency: 1,
    user_confirmation: 0,
    contradiction_penalty: 0,
    risk,
  };
}

export interface MaterializeSummary {
  threadIds: string[];
  eventsCreated: number;
  openLoopsCreated: number;
  openLoopsUpdated: number;
  openLoopsClosed: number;
  proposalsCreated: number;
}

export function materializeExtraction(conversationId: string, extraction: OkExtraction, config: ThreadkeeperConfig, now = Date.now()): MaterializeSummary {
  const db = getDb();
  const summary: MaterializeSummary = { threadIds: [], eventsCreated: 0, openLoopsCreated: 0, openLoopsUpdated: 0, openLoopsClosed: 0, proposalsCreated: 0 };

  // ── Thread resolution (layered: exact normalized title -> hint -> lexical -> new) ──
  const threadAssignments: Array<{ threadId: string; sourceIds: Set<string> }> = [];
  extraction.output.thread_candidates.forEach((candidate, index) => {
    const artifact = extraction.byType.threads[index]!;
    const normalized = normalizeText(candidate.title);
    let thread: ThreadRow | null =
      findThreadByNormalizedTitle(db, normalized) ??
      (candidate.existing_thread_hint
        ? findThreadByNormalizedTitle(db, normalizeText(candidate.existing_thread_hint)) ?? findThreadByLexicalMatch(db, candidate.existing_thread_hint)
        : null) ??
      findThreadByLexicalMatch(db, candidate.title);
    if (thread) touchThread(db, thread.id, now);
    else thread = createThread(db, candidate.title, candidate.summary || null, now);
    addThreadMembership(db, thread.id, "conversation", conversationId, "source", candidate.confidence);
    addThreadMembership(db, thread.id, "artifact", artifact.id, "source", candidate.confidence);
    threadAssignments.push({ threadId: thread.id, sourceIds: new Set(candidate.source_message_ids) });
    summary.threadIds.push(thread.id);
  });

  function bestThreadFor(sourceIds: string[]): string | null {
    let best: { id: string; overlap: number } | null = null;
    for (const assignment of threadAssignments) {
      let overlap = 0;
      for (const id of sourceIds) if (assignment.sourceIds.has(id)) overlap++;
      if (overlap > 0 && (!best || overlap > best.overlap)) best = { id: assignment.threadId, overlap };
    }
    return best?.id ?? null;
  }

  // ── Events: descriptive timeline entries, always materialized directly ──
  extraction.output.events.forEach((candidate, index) => {
    const artifact = extraction.byType.events[index]!;
    const threadId = bestThreadFor(candidate.source_message_ids);
    insertEvent(
      db,
      {
        threadId,
        eventType: candidate.type,
        title: candidate.title,
        description: candidate.description || null,
        occurredAt: toEpochMs(candidate.occurred_at),
        status: "recorded",
        createdFromArtifactId: artifact.id,
      },
      now,
    );
    summary.eventsCreated++;
    if (threadId) touchThread(db, threadId, now);
  });

  // ── Open loops: direct statements materialize; inferred ones become proposals ──
  extraction.output.open_loop_candidates.forEach((candidate, index) => {
    const artifact = extraction.byType.openLoops[index]!;
    const threadId = bestThreadFor(candidate.source_message_ids);
    const dueAt = toEpochMs(candidate.due_at);

    if (candidate.origin === "direct") {
      const openInThread = threadId ? findOpenLoopsForThread(db, threadId, "open") : [];
      const match = openInThread
        .map((loop) => ({ loop, score: lexicalSimilarity(loop.description, candidate.description) }))
        .filter((m) => m.score >= DIRECT_MATCH_SIMILARITY)
        .sort((a, b) => b.score - a.score)[0];
      if (match) {
        updateOpenLoop(db, match.loop.id, { next_action: candidate.next_action ?? undefined, due_at: dueAt ?? undefined }, now);
        summary.openLoopsUpdated++;
      } else {
        insertOpenLoop(
          db,
          {
            threadId,
            description: candidate.description,
            nextAction: candidate.next_action,
            dueAt,
            originType: "direct",
            confidence: candidate.confidence,
            createdFromArtifactId: artifact.id,
          },
          now,
        );
        summary.openLoopsCreated++;
      }
      return;
    }

    const fp = fingerprint({ op: "create_open_loop", threadId, description: normalizeText(candidate.description) });
    if (isFingerprintSuppressed(db, fp, config.serendipity.dismissalCooldownDays, now)) return;
    const { created } = createProposal(
      db,
      {
        proposalType: "create_open_loop",
        targetType: "thread",
        targetId: threadId,
        operation: "create",
        payload: { threadId, description: candidate.description, nextAction: candidate.next_action, dueAt, originType: "inferred", artifactId: artifact.id },
        fingerprint: fp,
        confidence: confidenceOf(candidate.confidence, 0.6, 1, "medium"),
        createdByRunId: extraction.runId,
        expiresAt: null,
      },
      now,
    );
    if (created) summary.proposalsCreated++;
  });

  // ── Closures: unambiguous direct completion closes the loop; ambiguous ones propose it ──
  extraction.output.closure_candidates.forEach((candidate, index) => {
    const artifact = extraction.byType.closures[index]!;
    const threadId = bestThreadFor(candidate.source_message_ids);
    const pool = threadId ? findOpenLoopsForThread(db, threadId, "open") : (listOpenLoops(db, "open", 200));
    const match = pool
      .map((loop) => ({ loop, score: lexicalSimilarity(loop.description, candidate.description) }))
      .sort((a, b) => b.score - a.score)[0];

    if (match && match.score >= DIRECT_CLOSE_SIMILARITY) {
      updateOpenLoop(db, match.loop.id, { status: "done" }, now);
      summary.openLoopsClosed++;
      return;
    }

    const fp = fingerprint({ op: "close_loop", threadId, description: normalizeText(candidate.description), targetId: match?.loop.id ?? null });
    if (isFingerprintSuppressed(db, fp, config.serendipity.dismissalCooldownDays, now)) return;
    const { created } = createProposal(
      db,
      {
        proposalType: "close_loop",
        targetType: "open_loop",
        targetId: match?.loop.id ?? null,
        operation: "close",
        payload: { description: candidate.description, matchedLoopId: match?.loop.id ?? null, matchScore: match?.score ?? 0 },
        fingerprint: fp,
        confidence: confidenceOf(candidate.confidence, 0.5, 1, "medium"),
        createdByRunId: extraction.runId,
        expiresAt: null,
      },
      now,
    );
    if (created) summary.proposalsCreated++;
  });

  // ── Claims: always proposals in v1 — evidence and review over automatic action (plan §0.10) ──
  extraction.output.claim_candidates.forEach((candidate, index) => {
    const artifact = extraction.byType.claims[index]!;
    const existing = findActiveClaim(db, candidate.subject, candidate.predicate);
    const sameValue = existing != null && canonicalize(JSON.parse(existing.object_json)) === canonicalize(candidate.object);
    if (existing && sameValue) return; // nothing new to propose

    const proposalType = existing ? "supersede_claim" : "create_claim";
    const risk: "low" | "medium" | "high" = candidate.sensitive ? "high" : candidate.epistemic_type === "direct_fact" ? "low" : "medium";
    const fp = fingerprint({
      op: proposalType,
      subject: candidate.subject,
      predicate: candidate.predicate,
      object: candidate.object,
      supersedes: existing?.id ?? null,
    });
    if (isFingerprintSuppressed(db, fp, config.serendipity.dismissalCooldownDays, now)) return;
    const { created } = createProposal(
      db,
      {
        proposalType,
        targetType: "claim",
        targetId: existing?.id ?? null,
        operation: existing ? "supersede" : "create",
        payload: {
          subject: candidate.subject,
          predicate: candidate.predicate,
          object: candidate.object,
          epistemicType: candidate.epistemic_type,
          temporalStatus: candidate.temporal_status,
          supersedesClaimId: existing?.id ?? null,
          artifactId: artifact.id,
        },
        fingerprint: fp,
        confidence: confidenceOf(candidate.confidence, candidate.epistemic_type === "direct_fact" ? 0.9 : 0.6, 1, risk),
        createdByRunId: extraction.runId,
        expiresAt: null,
      },
      now,
    );
    if (created) summary.proposalsCreated++;
  });

  return summary;
}
