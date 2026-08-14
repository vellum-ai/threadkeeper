/**
 * Threadkeeper's core surface — the single module every tool/route file dynamically imports.
 * Every exported function here is a bounded, fail-open, runtime-validated operation over SQLite
 * (plus, for the enqueue-and-try-run helpers, a best-effort inline job attempt). Nothing here holds
 * a transaction across a model call or a broad scan.
 */
import { getConfig } from "./config.ts";
import { getDb } from "./db.ts";
import { ThreadkeeperError, toErrorInfo } from "./errors.ts";
import { fingerprint, lexicalSimilarity, newId } from "./ids.ts";
import { enrichProvenance, provenanceForArtifact, provenanceForCreatedFromArtifact } from "./provenance.ts";
import { enqueueAndTryRun, processQueue as processQueueCore, type ProcessQueueResult } from "./queueProcessor.ts";
import { listConnections, listProposals } from "./repositories/review.ts";
import {
  findOpenLoopsForThread,
  getOpenLoop,
  getThread as getThreadRow,
  listEventsForThread,
  listOpenLoops as listOpenLoopsRepo,
  listThreadMemberships,
  listThreads as listThreadsRepo,
} from "./repositories/projections.ts";
import { getDirtyStats, getJob as getJobRow, listJobsByStatus } from "./repositories/queue.ts";
import { countIndexDocuments } from "./repositories/audit.ts";
import { normalizeBackfillRequest, presetScope, readPersistedBackfillScope, writePersistedBackfillScope } from "./backfillScope.ts";
import type { BackfillMode } from "./backfill.ts";
import type { BackfillScopeInput } from "./types.ts";
import type { ArchaeologyInput } from "./archaeology.ts";
import type { ClaimRow, ConnectionRow, EventRow, OpenLoopRow, ProposalRow, ThreadRow } from "./types.ts";

// ─── Shaping: DB rows -> API-facing objects, evidence attached ─────────────

function shapeThread(thread: ThreadRow) {
  return {
    id: thread.id,
    title: thread.title,
    summary: thread.summary,
    status: thread.status,
    createdAt: thread.created_at,
    updatedAt: thread.updated_at,
    archivedAt: thread.archived_at,
  };
}

async function shapeOpenLoop(loop: OpenLoopRow) {
  const sources = await enrichProvenance(provenanceForCreatedFromArtifact(loop.created_from_artifact_id));
  return {
    id: loop.id,
    kind: "open_loop",
    threadId: loop.thread_id,
    title: loop.description,
    description: loop.description,
    nextAction: loop.next_action,
    status: loop.status,
    dueAt: loop.due_at,
    originType: loop.origin_type,
    confidence: loop.confidence,
    createdAt: loop.created_at,
    updatedAt: loop.updated_at,
    excerpt: sources[0]?.excerpt ?? null,
    conversation: sources[0]?.conversationId ? {
      id: sources[0].conversationId,
      title: sources[0].conversationTitle,
      date: sources[0].conversationDate ?? sources[0].occurredAt,
    } : null,
    sources,
  };
}

function shapeEvent(event: EventRow) {
  return {
    id: event.id,
    threadId: event.thread_id,
    type: event.event_type,
    title: event.title,
    description: event.description,
    occurredAt: event.occurred_at,
    sources: provenanceForCreatedFromArtifact(event.created_from_artifact_id),
  };
}

function shapeClaim(claim: ClaimRow) {
  return {
    id: claim.id,
    subject: claim.subject,
    predicate: claim.predicate,
    object: JSON.parse(claim.object_json),
    epistemicType: claim.epistemic_type,
    status: claim.status,
    supersedesClaimId: claim.supersedes_claim_id,
    sources: provenanceForCreatedFromArtifact(claim.created_from_artifact_id),
  };
}

function readable(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(readable).filter(Boolean).join(", ");
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    if ("value" in object) return readable(object.value);
    return Object.entries(object).map(([key, entry]) => `${key.replaceAll("_", " ")}: ${readable(entry)}`).join(", ");
  }
  return String(value);
}

function proposalCopy(proposal: ProposalRow, payload: Record<string, unknown>) {
  const claim = [payload.subject, payload.predicate, readable(payload.object)].filter(Boolean).join(" ");
  const description = String(payload.description ?? "").trim();
  const reason = String(payload.reason ?? "").trim();
  switch (proposal.proposal_type) {
    case "create_open_loop":
      return { title: `Add open loop: ${description || "Follow up"}`, description: "Threadkeeper inferred this unfinished item and will add it to Open now if accepted.", nextAction: payload.nextAction ? String(payload.nextAction) : null, impact: "Creates a new open loop." };
    case "close_loop":
      return { title: `Mark complete: ${description || "Open loop"}`, description: "Threadkeeper found evidence that this item may already be finished.", nextAction: null, impact: "Marks the matched open loop done." };
    case "create_claim":
      return { title: `Add claim: ${claim || "New remembered fact"}`, description: `Proposed as ${String(payload.epistemicType ?? "interpretation").replaceAll("_", " ")}.`, nextAction: null, impact: "Adds this as a reviewed Threadkeeper claim." };
    case "supersede_claim":
    case "update_claim":
      return { title: `Update claim: ${claim || "Existing fact"}`, description: "Threadkeeper found newer evidence that may change an existing claim.", nextAction: null, impact: "Keeps the old claim as history and makes this the current version." };
    case "mark_historical":
      return { title: `Mark claim historical${reason ? `: ${reason}` : ""}`, description: "This claim may no longer be current or may have lost its supporting evidence.", nextAction: null, impact: "Retains the claim as history instead of current state." };
    case "merge_duplicates":
      return { title: "Merge duplicate claims", description: reason || "Threadkeeper found two claims that appear to say the same thing.", nextAction: null, impact: "Keeps one claim and supersedes the duplicate." };
    case "reopen_loop":
      return { title: `Reopen loop: ${description || "Previous item"}`, description: reason || "New evidence suggests this item still needs attention.", nextAction: null, impact: "Moves the loop back to Open now." };
    case "archive_thread":
      return { title: `Archive thread: ${String(payload.title ?? payload.threadTitle ?? "Dormant thread")}`, description: reason || "This thread appears inactive.", nextAction: null, impact: "Removes the thread from active views without deleting its history." };
    default:
      return { title: `${proposal.operation.replaceAll("_", " ")}: ${description || claim || proposal.target_type || "Review item"}`, description: reason || "Threadkeeper is proposing a reviewed change.", nextAction: null, impact: "Applies the proposed change." };
  }
}

function displayConfidence(components: Record<string, unknown>): number | null {
  const extraction = Number(components.extraction);
  const evidence = Number(components.evidence_quality);
  if (!Number.isFinite(extraction) && !Number.isFinite(evidence)) return null;
  if (!Number.isFinite(extraction)) return Math.max(0, Math.min(1, evidence));
  if (!Number.isFinite(evidence)) return Math.max(0, Math.min(1, extraction));
  return Math.max(0, Math.min(1, extraction * 0.6 + evidence * 0.4));
}

async function shapeProposal(proposal: ProposalRow) {
  const payload = JSON.parse(proposal.proposed_payload_json) as Record<string, unknown>;
  const confidenceComponents = JSON.parse(proposal.confidence_json) as Record<string, unknown>;
  const artifactId = typeof payload.artifactId === "string" ? payload.artifactId : null;
  const targetClaim = proposal.target_type === "claim" && proposal.target_id ? getDb().query(`SELECT created_from_artifact_id FROM claims WHERE id = ?`).get(proposal.target_id) as { created_from_artifact_id: string | null } | null : null;
  const sources = await enrichProvenance(artifactId ? provenanceForArtifact(artifactId) : provenanceForCreatedFromArtifact(targetClaim?.created_from_artifact_id ?? null));
  const copy = proposalCopy(proposal, payload);
  return {
    id: proposal.id,
    kind: "proposal",
    proposalType: proposal.proposal_type,
    targetType: proposal.target_type,
    targetId: proposal.target_id,
    operation: proposal.operation,
    payload,
    ...copy,
    status: proposal.status,
    confidence: displayConfidence(confidenceComponents),
    confidenceComponents,
    risk: typeof confidenceComponents.risk === "string" ? confidenceComponents.risk : null,
    createdAt: proposal.created_at,
    reviewedAt: proposal.reviewed_at,
    excerpt: sources[0]?.excerpt ?? null,
    conversation: sources[0]?.conversationId ? {
      id: sources[0].conversationId,
      title: sources[0].conversationTitle,
      date: sources[0].conversationDate ?? sources[0].occurredAt,
    } : null,
    sources,
  };
}

function shapeConnection(connection: ConnectionRow) {
  return {
    id: connection.id,
    fromType: connection.from_type,
    fromId: connection.from_id,
    toType: connection.to_type,
    toId: connection.to_id,
    relationType: connection.relation_type,
    explanation: connection.explanation,
    score: JSON.parse(connection.score_json),
    status: connection.status,
    createdAt: connection.created_at,
  };
}

function clampLimit(limit: unknown, fallback: number, max: number): number {
  const n = Number(limit);
  return Number.isFinite(n) ? Math.max(1, Math.min(max, Math.floor(n))) : fallback;
}

// ─── status ──────────────────────────────────────────────────────────────────

export async function getStatus(): Promise<Record<string, unknown>> {
  const db = getDb();
  const dirty = getDirtyStats(db);
  const jobs = listJobsByStatus(db);
  const config = getConfig();
  const proposalCount = (db.query(`SELECT COUNT(*) as n FROM proposals WHERE status = 'pending'`).get() as { n: number }).n;
  const connectionCount = (db.query(`SELECT COUNT(*) as n FROM connections WHERE status = 'pending'`).get() as { n: number }).n;
  const threadCount = (db.query(`SELECT COUNT(*) as n FROM threads WHERE status != 'archived'`).get() as { n: number }).n;
  const openLoopCount = (db.query(`SELECT COUNT(*) as n FROM open_loops WHERE status = 'open'`).get() as { n: number }).n;
  const lastRun = db.query(`SELECT MAX(started_at) as t FROM pipeline_runs`).get() as { t: number | null };
  const lastError = db.query(`SELECT error_code FROM pipeline_runs WHERE error_code IS NOT NULL ORDER BY started_at DESC LIMIT 1`).get() as
    | { error_code: string }
    | null;
  return {
    captureEnabled: config.captureEnabled,
    queueDepth: dirty.count,
    dirtyOldestAgeMs: dirty.oldestAgeMs,
    jobsByStatus: jobs,
    reviewCount: proposalCount + connectionCount,
    proposalCount,
    connectionCount,
    openLoopCount,
    threadCount,
    indexDocumentCount: countIndexDocuments(db),
    lastRunAt: lastRun.t ?? null,
    lastErrorCode: lastError?.error_code ?? null,
    serendipityEnabled: config.serendipity.enabled,
  };
}

export const status = getStatus;

// ─── search ──────────────────────────────────────────────────────────────────

export async function search(input: { query?: string; limit?: number }): Promise<{ items: unknown[] }> {
  const query = String(input.query ?? "").trim();
  if (!query) return { items: [] };
  const limit = clampLimit(input.limit, 20, 50);
  const db = getDb();
  const threads = db.query(`SELECT * FROM threads LIMIT 500`).all() as ThreadRow[];
  const loops = db.query(`SELECT * FROM open_loops LIMIT 500`).all() as OpenLoopRow[];
  const claims = db.query(`SELECT * FROM claims WHERE status = 'active' LIMIT 500`).all() as ClaimRow[];

  const scored: Array<{ matchType: string; score: number; item: unknown }> = [];
  for (const t of threads) {
    const s = Math.max(lexicalSimilarity(query, t.title), lexicalSimilarity(query, t.summary ?? ""));
    if (s > 0.05) scored.push({ matchType: "thread", score: s, item: shapeThread(t) });
  }
  for (const l of loops) {
    const s = lexicalSimilarity(query, l.description);
    if (s > 0.05) scored.push({ matchType: "open_loop", score: s, item: await shapeOpenLoop(l) });
  }
  for (const c of claims) {
    const s = lexicalSimilarity(query, `${c.subject} ${c.predicate}`);
    if (s > 0.05) scored.push({ matchType: "claim", score: s, item: shapeClaim(c) });
  }
  scored.sort((a, b) => b.score - a.score);
  return { items: scored.slice(0, limit).map((s) => ({ matchType: s.matchType, score: s.score, ...(s.item as object) })) };
}

export const searchThreadkeeper = search;

// ─── threads ─────────────────────────────────────────────────────────────────

export async function listThreads(input: { status?: string; limit?: number }): Promise<{ items: unknown[] }> {
  const db = getDb();
  const rows = listThreadsRepo(db, input.status ?? "active", clampLimit(input.limit, 50, 50));
  return { items: rows.map(shapeThread) };
}

export async function getThread(input: { id: string }): Promise<Record<string, unknown>> {
  const db = getDb();
  const thread = getThreadRow(db, input.id);
  if (!thread) throw new ThreadkeeperError("NOT_FOUND", `thread ${input.id} not found`);
  const events = listEventsForThread(db, input.id).map(shapeEvent);
  const openLoops = await Promise.all(findOpenLoopsForThread(db, input.id).map(shapeOpenLoop));
  const connections = (
    db.query(`SELECT * FROM connections WHERE (from_type = 'thread' AND from_id = ?) OR (to_type = 'thread' AND to_id = ?)`).all(
      input.id,
      input.id,
    ) as ConnectionRow[]
  ).map(shapeConnection);
  const memberships = listThreadMemberships(db, input.id);
  return { ...shapeThread(thread), events, openLoops, connections, memberCount: memberships.length };
}

// ─── open loops ──────────────────────────────────────────────────────────────

export async function listOpenLoops(input: { status?: string; limit?: number }): Promise<{ items: unknown[] }> {
  const db = getDb();
  const rows = listOpenLoopsRepo(db, input.status ?? "active", clampLimit(input.limit, 50, 50));
  return { items: await Promise.all(rows.map(shapeOpenLoop)) };
}

// ─── reviews (proposals + connections + pending archaeology jobs) ──────────

export async function listReviews(input: { type?: string; limit?: number }): Promise<{ items: unknown[] }> {
  const db = getDb();
  const limit = clampLimit(input.limit, 50, 50);
  const type = input.type ?? "all";
  const items: unknown[] = [];
  if (type === "proposal" || type === "all") items.push(...await Promise.all(listProposals(db, "pending", limit).map(shapeProposal)));
  if (type === "connection" || type === "all") items.push(...listConnections(db, "pending", limit).map((c) => ({ kind: "connection", ...shapeConnection(c) })));
  if (type === "archaeology") {
    const jobs = db.query(`SELECT * FROM jobs WHERE job_type = 'archaeology' AND status IN ('pending','running') ORDER BY created_at DESC LIMIT ?`).all(
      limit,
    ) as Array<{ id: string; status: string; input_json: string; created_at: number }>;
    items.push(...jobs.map((j) => ({ kind: "archaeology_job", id: j.id, status: j.status, input: JSON.parse(j.input_json), createdAt: j.created_at })));
  }
  return { items: items.slice(0, limit) };
}

// ─── process queue (the background path, invoked by the tool or the schedule) ──

export async function processQueue(input?: { maxJobs?: number; trigger?: string } | number): Promise<ProcessQueueResult> {
  const config = getConfig();
  const maxJobs = typeof input === "number" ? input : clampLimit(input?.maxJobs, config.maxJobsPerRun, 20);
  return processQueueCore(maxJobs, config);
}

// ─── jobs ────────────────────────────────────────────────────────────────────

export async function getJob(input: { id: string }): Promise<Record<string, unknown>> {
  const db = getDb();
  const job = getJobRow(db, input.id);
  if (!job) throw new ThreadkeeperError("NOT_FOUND", `job ${input.id} not found`);
  return {
    id: job.id,
    jobType: job.job_type,
    status: job.status,
    attempts: job.attempts,
    createdAt: job.created_at,
    updatedAt: job.updated_at,
    lastErrorCode: job.last_error_code,
    result: job.status === "succeeded" ? job.output : null,
  };
}

function shapeJobResult(result: { jobId: string; status: "succeeded" | "pending" | "failed"; output: unknown }) {
  return { ok: true, jobId: result.jobId, status: result.status, result: result.status === "succeeded" ? result.output : null };
}

// ─── archaeology (always job-backed; may resolve inline when fast) ─────────

export async function enqueueArchaeology(input: { query?: string; threadId?: string | null; conversationId?: string }): Promise<unknown> {
  const query = String(input.query ?? "").trim();
  if (!query) throw new ThreadkeeperError("ROUTE_VALIDATION_FAILED", "query is required for archaeology");
  const config = getConfig();
  const jobInput: ArchaeologyInput = { query, threadId: input.threadId ?? null };
  const idempotencyKey = fingerprint({ kind: "archaeology", query, threadId: input.threadId ?? null });
  const result = await enqueueAndTryRun("archaeology", jobInput, idempotencyKey, config);
  return shapeJobResult(result);
}

export const requestArchaeology = enqueueArchaeology;

// ─── index rebuild ───────────────────────────────────────────────────────────

export async function enqueueIndexRebuild(): Promise<unknown> {
  const config = getConfig();
  const result = await enqueueAndTryRun("rebuild_index", {}, `rebuild_index:${newId()}`, config);
  return shapeJobResult(result);
}

// ─── backfill ────────────────────────────────────────────────────────────────

export async function startBackfill(input: BackfillScopeInput & { conversationId?: string } = {}): Promise<unknown> {
  const config = getConfig();
  const db = getDb();
  const configuredScope = readPersistedBackfillScope(db)
    ?? (config.backfillScope?.kind === "preset" && config.backfillScope.preset === "future_only" && config.backfillMode !== "future_only"
      ? presetScope(config.backfillMode)
      : config.backfillScope ?? presetScope("future_only"));
  const hasExplicitScope = Object.keys(input).some((key) => ["mode", "scope", "backfillScope", "days", "dayCount", "startDate", "endDate"].includes(key) && input[key as keyof typeof input] !== undefined);
  const request = hasExplicitScope ? input : { scope: configuredScope };
  const scope = normalizeBackfillRequest(request);
  if (hasExplicitScope) writePersistedBackfillScope(db, scope);
  const idempotencyKey = fingerprint({ kind: "backfill", scope, day: new Date(Date.now()).toISOString().slice(0, 10) });
  const result = await enqueueAndTryRun("backfill", { scope }, idempotencyKey, config);
  return shapeJobResult(result);
}

// ─── review / connection actions ────────────────────────────────────────────

const REVIEW_ACTIONS = new Set([
  "accept_proposal",
  "reject_proposal",
  "snooze",
  "mark_done",
  "archive_thread",
  "explore",
  "save_as_hypothesis",
  "create_open_loop",
  "dismiss_connection",
  "mark_wrong",
]);

export async function enqueueAction(payload: Record<string, unknown>): Promise<unknown> {
  const kind = String(payload.kind ?? payload.action ?? "");
  if (kind === "archaeology" || kind === "request_archaeology") {
    return enqueueArchaeology({ query: String(payload.query ?? ""), threadId: (payload.threadId as string | undefined) ?? null });
  }
  if (kind === "rebuild_index") return enqueueIndexRebuild();
  if (kind === "start_backfill" || kind === "backfill") return startBackfill(payload as BackfillScopeInput);
  if (kind === "process_queue") return processQueue({ maxJobs: payload.maxJobs as number | undefined });
  if (!REVIEW_ACTIONS.has(kind)) throw new ThreadkeeperError("ROUTE_VALIDATION_FAILED", `unsupported action: ${kind}`);

  const targetId = String(payload.targetId ?? "");
  if (!targetId) throw new ThreadkeeperError("ROUTE_VALIDATION_FAILED", "a target id is required");
  const config = getConfig();
  const reviewInput = { action: kind, targetId, reason: (payload.reason as string | null | undefined) ?? null };
  const idempotencyKey = fingerprint({ kind: "review_action", action: kind, targetId });
  const result = await enqueueAndTryRun("review_action", reviewInput, idempotencyKey, config);
  return shapeJobResult(result);
}

export const applyAction = enqueueAction;
export const reviewAction = enqueueAction;
export const enqueueJob = enqueueAction;
