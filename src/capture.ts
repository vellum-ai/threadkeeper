import { getConfig } from "./config.ts";
import { getDb } from "./db.ts";
import { markDirty } from "./repositories/queue.ts";

/**
 * The `stop` hook algorithm: one short UPSERT, nothing else. No message parsing, no inference,
 * no broad history reads. Callers (hooks/stop.ts) must catch and swallow every error themselves —
 * this function does not, so its failure mode is visible to tests, but production call sites fail open.
 */
export function captureStop(conversationId: string, requestId: string | null): void {
  const config = getConfig();
  if (!config.captureEnabled || !config.sources.conversations) return;
  const db = getDb();
  markDirty(db, conversationId, requestId);
}
