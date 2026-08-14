/**
 * Incremental finalized-message ingestion. Runs entirely outside the live turn path (called only
 * from the background queue processor). Builds immutable evidence: `sources` + `source_revisions`.
 * Never advances the conversation cursor itself — the caller only does that after the artifacts
 * derived from this batch have committed (see queueProcessor.ts), so a crash between ingestion and
 * extraction is safely retried rather than silently skipping the batch.
 */
import * as pluginApi from "@vellumai/plugin-api";
import { getDb } from "./db.ts";
import { contentHash } from "./ids.ts";
import { isTombstoned } from "./repositories/audit.ts";
import { insertSourceRevision, upsertSource } from "./repositories/evidence.ts";
import { getCursor, setFullRescanRequired, touchCursorSeen } from "./repositories/queue.ts";
import type { SourceRevisionRow } from "./types.ts";

export type IngestStatus = "ok" | "conversation_active" | "tombstoned" | "no_changes";

export interface IngestedMessage {
  revision: SourceRevisionRow;
  messageId: string;
  role: "user" | "assistant";
  createdAt: number;
  text: string;
}

export interface IngestResult {
  status: IngestStatus;
  newRevisions: IngestedMessage[];
  lastMessageId: string | null;
  /** True when the bounded batch left more unprocessed messages; caller should keep the conversation dirty. */
  hasMore: boolean;
}

const EXCERPT_CHARS = 600;

type ProcessingApi = {
  isConversationProcessing?: (conversationId: string) => Promise<boolean> | boolean;
};

/**
 * Older plugin-api runtimes do not export isConversationProcessing. Keep the
 * optional capability check at the boundary so fresh route/scheduler contexts
 * continue ingestion instead of failing during module evaluation or invocation.
 */
export async function isConversationCurrentlyProcessing(api: ProcessingApi, conversationId: string): Promise<boolean> {
  const helper = api.isConversationProcessing;
  return typeof helper === "function" ? await helper(conversationId) : false;
}

export async function ingestConversation(conversationId: string, maxMessages: number): Promise<IngestResult> {
  const db = getDb();
  if (isTombstoned(db, "conversation", conversationId)) {
    return { status: "tombstoned", newRevisions: [], lastMessageId: null, hasMore: false };
  }
  if (await isConversationCurrentlyProcessing(pluginApi, conversationId)) {
    return { status: "conversation_active", newRevisions: [], lastMessageId: null, hasMore: false };
  }

  const rows = await pluginApi.getMessages(conversationId);
  const finalized = rows
    .filter((row) => row.finalized === 1 && (row.role === "user" || row.role === "assistant"))
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt);

  touchCursorSeen(db, conversationId);
  const cursor = getCursor(db, conversationId);

  let candidates = finalized;
  if (cursor?.last_processed_message_id) {
    const idx = finalized.findIndex((row) => row.id === cursor.last_processed_message_id);
    if (idx >= 0) {
      candidates = finalized.slice(idx + 1);
    } else {
      // Cursor's anchor message is gone (edited away, forked, or otherwise unrecognizable).
      // Safe reconciliation: reconsider every finalized row; idempotent inserts no-op the unchanged ones.
      setFullRescanRequired(db, conversationId);
      candidates = finalized;
    }
  }

  if (candidates.length === 0) {
    return { status: "no_changes", newRevisions: [], lastMessageId: cursor?.last_processed_message_id ?? null, hasMore: false };
  }

  const hasMore = candidates.length > maxMessages;
  const batch = candidates.slice(0, maxMessages);

  const newRevisions: IngestedMessage[] = [];
  for (const row of batch) {
    const text = pluginApi.stringifyMessageContent(row.content);
    if (!text.trim()) continue; // pure tool-call / structural turn — no spoken evidence to capture
    const source = upsertSource(db, {
      sourceType: "conversation_message",
      stableLocator: row.id,
      conversationId,
      messageId: row.id,
      role: row.role,
      sourceTimestamp: row.createdAt,
    });
    const revision = insertSourceRevision(db, {
      sourceId: source.id,
      contentHash: contentHash(text),
      capturedAt: Date.now(),
      contentLength: text.length,
      excerpt: text.slice(0, EXCERPT_CHARS),
      canonicalText: text,
    });
    newRevisions.push({ revision, messageId: row.id, role: row.role as "user" | "assistant", createdAt: row.createdAt, text });
  }

  return { status: "ok", newRevisions, lastMessageId: batch[batch.length - 1]!.id, hasMore };
}
