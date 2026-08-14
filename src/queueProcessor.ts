/**
 * The background path: drains the dirty-conversation queue and the bounded job queue in one call.
 * This is what the `process_queue` tool action and the quiet recurring schedule both invoke. Never
 * called from a hook — only from a tool execution or the schedule's own turn.
 */
import type { ThreadkeeperConfig } from "./config.ts";
import { getDb } from "./db.ts";
import { toErrorInfo } from "./errors.ts";
import { runArchaeology, type ArchaeologyInput } from "./archaeology.ts";
import { startBackfill } from "./backfill.ts";
import type { BackfillScope } from "./types.ts";
import { runReviewAction, type ReviewActionInput } from "./actions.ts";
import { runExtraction } from "./extraction.ts";
import { runGardenerSweep } from "./gardener.ts";
import { ingestConversation } from "./ingestion.ts";
import { indexOwner } from "./index-doc.ts";
import { materializeExtraction } from "./policy.ts";
import { getThread } from "./repositories/projections.ts";
import {
  advanceCursor,
  claimDirtyBatch,
  claimJobs,
  clearDirty,
  completeJob,
  createJob,
  failJob,
  markDirtyRetry,
  type ParsedJob,
} from "./repositories/queue.ts";
import { buildThreadDocument, runSerendipitySweep } from "./serendipity.ts";

const JOB_LEASE_MS = 5 * 60 * 1000;

export interface ProcessQueueResult {
  dirtyClaimed: number;
  conversationsProcessed: number;
  conversationsDeferred: number;
  conversationErrors: number;
  gardenerProposals: number;
  serendipityConnections: number;
  jobsClaimed: number;
  jobsSucceeded: number;
  jobsFailed: number;
}

async function processDirtyConversation(conversationId: string, config: ThreadkeeperConfig): Promise<{ outcome: "processed" | "deferred" | "no_changes" | "error"; threadIds: string[] }> {
  const db = getDb();
  const ingested = await ingestConversation(conversationId, config.maxMessagesPerConversationRun);

  if (ingested.status === "tombstoned") {
    clearDirty(db, conversationId);
    return { outcome: "no_changes", threadIds: [] };
  }
  if (ingested.status === "conversation_active") {
    return { outcome: "deferred", threadIds: [] };
  }
  if (ingested.status === "no_changes") {
    clearDirty(db, conversationId);
    return { outcome: "no_changes", threadIds: [] };
  }

  // status === "ok"
  if (ingested.newRevisions.length === 0) {
    if (ingested.lastMessageId) advanceCursor(db, conversationId, ingested.lastMessageId);
    if (!ingested.hasMore) clearDirty(db, conversationId);
    return { outcome: "processed", threadIds: [] };
  }

  const extraction = await runExtraction(conversationId, ingested.newRevisions, config);
  if (extraction.status === "no_provider" || extraction.status === "provider_error" || extraction.status === "invalid") {
    const code = extraction.status === "no_provider" ? "NO_PROVIDER" : extraction.status === "provider_error" ? "PROVIDER_ERROR" : "INVALID_MODEL_JSON";
    markDirtyRetry(db, conversationId, code);
    return { outcome: "error", threadIds: [] };
  }

  let threadIds: string[] = [];
  if (extraction.status === "ok") {
    const summary = materializeExtraction(conversationId, extraction, config);
    threadIds = summary.threadIds;
    for (const threadId of new Set(threadIds)) {
      const doc = buildThreadDocument(threadId);
      if (doc.text.trim()) await indexOwner("thread", threadId, doc.text, { title: getThread(db, threadId)?.title });
    }
  }
  // "skipped_cached": artifacts already exist for this exact input; nothing new to materialize.

  if (ingested.lastMessageId) advanceCursor(db, conversationId, ingested.lastMessageId);
  if (!ingested.hasMore) clearDirty(db, conversationId);
  return { outcome: "processed", threadIds };
}

async function runJob(job: ParsedJob, config: ThreadkeeperConfig): Promise<unknown> {
  switch (job.job_type) {
    case "archaeology":
      return runArchaeology(job.input as ArchaeologyInput, config);
    case "backfill":
      return startBackfill((job.input as { scope: BackfillScope }).scope);
    case "review_action":
      return runReviewAction(getDb(), job.input as ReviewActionInput);
    case "rebuild_index":
      return rebuildIndex();
    default:
      throw new Error(`unknown job type: ${job.job_type}`);
  }
}

export interface RebuildIndexResult {
  threadsIndexed: number;
}

/** Rebuild the private index from SQLite (the canonical source) — recovers from index/model drift. */
export async function rebuildIndex(): Promise<RebuildIndexResult> {
  const db = getDb();
  const threads = db.query(`SELECT id FROM threads WHERE status != 'archived'`).all() as Array<{ id: string }>;
  let threadsIndexed = 0;
  for (const { id } of threads) {
    const doc = buildThreadDocument(id);
    if (!doc.text.trim()) continue;
    const result = await indexOwner("thread", id, doc.text, { title: getThread(db, id)?.title });
    if (result.ok) threadsIndexed++;
  }
  return { threadsIndexed };
}

export async function processQueue(maxJobs: number, config: ThreadkeeperConfig): Promise<ProcessQueueResult> {
  const db = getDb();
  const result: ProcessQueueResult = {
    dirtyClaimed: 0,
    conversationsProcessed: 0,
    conversationsDeferred: 0,
    conversationErrors: 0,
    gardenerProposals: 0,
    serendipityConnections: 0,
    jobsClaimed: 0,
    jobsSucceeded: 0,
    jobsFailed: 0,
  };

  const batch = claimDirtyBatch(db, maxJobs);
  result.dirtyClaimed = batch.length;
  const touchedThreadIds: string[] = [];

  for (const dirty of batch) {
    try {
      const outcome = await processDirtyConversation(dirty.conversation_id, config);
      if (outcome.outcome === "processed") {
        result.conversationsProcessed++;
        touchedThreadIds.push(...outcome.threadIds);
      } else if (outcome.outcome === "deferred") {
        result.conversationsDeferred++;
      } else if (outcome.outcome === "error") {
        result.conversationErrors++;
      }
    } catch (cause) {
      const info = toErrorInfo(cause);
      markDirtyRetry(db, dirty.conversation_id, info.code);
      result.conversationErrors++;
    }
  }

  try {
    const gardener = runGardenerSweep(config);
    result.gardenerProposals = gardener.proposalsCreated;
  } catch {
    // Gardener is best-effort deterministic maintenance; a failure here must not fail the whole run.
  }

  if (config.serendipity.enabled && touchedThreadIds.length > 0) {
    try {
      const serendipity = await runSerendipitySweep([...new Set(touchedThreadIds)], config);
      result.serendipityConnections = serendipity.connectionsCreated;
    } catch {
      // Serendipity is speculative and must never block ordinary processing.
    }
  }

  const jobs = claimJobs(db, JOB_LEASE_MS, maxJobs);
  result.jobsClaimed = jobs.length;
  for (const job of jobs) {
    try {
      const output = await runJob(job, config);
      completeJob(db, job.id, output);
      result.jobsSucceeded++;
    } catch (cause) {
      const info = toErrorInfo(cause);
      failJob(db, job.id, info.code);
      result.jobsFailed++;
    }
  }

  return result;
}

/** Create a job and try to resolve it inline within this call; falls back to pending on any failure. */
export async function enqueueAndTryRun(
  jobType: "archaeology" | "rebuild_index" | "backfill" | "review_action",
  input: unknown,
  idempotencyKey: string,
  config: ThreadkeeperConfig,
): Promise<{ jobId: string; status: "succeeded" | "pending" | "failed"; output: unknown }> {
  const db = getDb();
  const job = createJob(db, { jobType, input, idempotencyKey });
  if (job.status === "succeeded") return { jobId: job.id, status: "succeeded", output: job.output };
  // Claims the oldest eligible job of this type, which may not be the one just created if others
  // of the same type are already queued; that job still gets picked up by the next drain, at worst
  // JOB_LEASE_MS later. Rare in practice — these job types are user-triggered, not high-volume.
  const [claimed] = claimJobs(db, JOB_LEASE_MS, 1, jobType);
  if (!claimed || claimed.id !== job.id) return { jobId: job.id, status: "pending", output: null };
  try {
    const output = await runJob(claimed, config);
    completeJob(db, job.id, output);
    return { jobId: job.id, status: "succeeded", output };
  } catch (cause) {
    const info = toErrorInfo(cause);
    failJob(db, job.id, info.code);
    return { jobId: job.id, status: "pending", output: null };
  }
}
