/**
 * Backfill: enqueue existing conversations into the dirty queue in bounded pages. Never processes
 * anything itself — it only marks conversations dirty, so the normal bounded queue processor drains
 * them over multiple runs. `future_only` is the safe default and enqueues nothing.
 */
import { listConversations } from "@vellumai/plugin-api";
import { getDb } from "./db.ts";
import { ThreadkeeperError } from "./errors.ts";
import {
  describeBackfillScope,
  isoDateEndMs,
  isoDateStartMs,
  normalizeBackfillRequest,
  normalizeBackfillScope,
  presetScope,
} from "./backfillScope.ts";
import { markDirty } from "./repositories/queue.ts";
import type { BackfillPreset, BackfillScope, BackfillScopeInput } from "./types.ts";

/** Kept as a compatibility alias for callers that only support the original fixed presets. */
export type BackfillMode = BackfillPreset;
export type { BackfillPreset, BackfillScope, BackfillScopeInput } from "./types.ts";

const PAGE_SIZE = 100;
const MAX_PAGES = 50; // safety cap: at most 5,000 conversations enqueued per invocation

function cutoffFor(scope: BackfillScope, now: number): { start: number | null; end: number | null } {
  if (scope.kind === "range") return { start: isoDateStartMs(scope.startDate), end: isoDateEndMs(scope.endDate) };
  if (scope.kind === "days") return { start: now - scope.days * 24 * 60 * 60 * 1000, end: null };
  if (scope.preset === "last_30_days") return { start: now - 30 * 24 * 60 * 60 * 1000, end: null };
  if (scope.preset === "last_90_days") return { start: now - 90 * 24 * 60 * 60 * 1000, end: null };
  return { start: null, end: null };
}

export interface BackfillResult {
  /** Compatibility field for callers using the original fixed-preset result shape. */
  mode: BackfillPreset | null;
  scope: BackfillScope;
  scopeDescription: string;
  enqueued: number;
  pagesScanned: number;
  bounded: boolean;
}

/**
 * Enqueue one bounded scan. The all-history preset is intentionally only accepted after the caller
 * has made an explicit confirmation; direct internal callers should pass a normalized scope.
 */
export async function startBackfill(
  input: BackfillScope | BackfillScopeInput | BackfillPreset = presetScope("future_only"),
  now = Date.now(),
): Promise<BackfillResult> {
  const isNormalizedScope = typeof input === "object" && input !== null && "kind" in input;
  const scope = typeof input === "string"
    ? normalizeBackfillScope(input)
    : isNormalizedScope
      ? normalizeBackfillScope(input, { requireAllConfirmation: false })
      : normalizeBackfillRequest(input as BackfillScopeInput);
  if (scope.kind === "preset" && scope.preset === "future_only") {
    return { mode: scope.kind === "preset" ? scope.preset : null, scope, scopeDescription: describeBackfillScope(scope), enqueued: 0, pagesScanned: 0, bounded: false };
  }

  const db = getDb();
  const cutoff = cutoffFor(scope, now);
  let enqueued = 0;
  let offset = 0;
  let page = 0;
  let bounded = false;
  for (; page < MAX_PAGES; page++) {
    const rows = await listConversations(PAGE_SIZE, undefined, offset, "all");
    if (rows.length === 0) break;
    const eligible = rows.filter((row) => {
      if (cutoff.start != null && row.updatedAt < cutoff.start) return false;
      if (cutoff.end != null && row.updatedAt > cutoff.end) return false;
      return true;
    });
    db.transaction(() => {
      for (const row of eligible) markDirty(db, row.id, null, now);
    })();
    enqueued += eligible.length;
    offset += rows.length;
    if (rows.length < PAGE_SIZE) {
      page++;
      break;
    }
  }
  bounded = page >= MAX_PAGES;
  return { mode: scope.kind === "preset" ? scope.preset : null, scope, scopeDescription: describeBackfillScope(scope), enqueued, pagesScanned: page, bounded };
}
