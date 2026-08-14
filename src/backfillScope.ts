import type { Database } from "bun:sqlite";
import { ThreadkeeperError } from "./errors.ts";
import type { BackfillPreset, BackfillScope, BackfillScopeInput } from "./types.ts";

export const BACKFILL_PRESETS = ["future_only", "last_30_days", "last_90_days", "all"] as const satisfies readonly BackfillPreset[];
export const MAX_CUSTOM_BACKFILL_DAYS = 36_500;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isBackfillPreset(value: unknown): value is BackfillPreset {
  return typeof value === "string" && (BACKFILL_PRESETS as readonly string[]).includes(value);
}

function assertIsoDate(value: unknown, field: "startDate" | "endDate"): string {
  if (typeof value !== "string" || !ISO_DATE_RE.test(value)) {
    throw new ThreadkeeperError("ROUTE_VALIDATION_FAILED", `${field} must be an ISO date in YYYY-MM-DD format`);
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new ThreadkeeperError("ROUTE_VALIDATION_FAILED", `${field} must be a valid calendar date`);
  }
  return value;
}

export function isoDateStartMs(value: string): number {
  return Date.parse(`${value}T00:00:00.000Z`);
}

export function isoDateEndMs(value: string): number {
  return isoDateStartMs(value) + 24 * 60 * 60 * 1000 - 1;
}

export function presetScope(preset: BackfillPreset): BackfillScope {
  return { kind: "preset", preset };
}

export function normalizeBackfillScope(input: unknown, options: { requireAllConfirmation?: boolean } = {}): BackfillScope {
  const requireAllConfirmation = options.requireAllConfirmation ?? true;
  if (input === undefined || input === null || input === "") return presetScope("future_only");

  if (isBackfillPreset(input)) {
    if (input === "all" && requireAllConfirmation) {
      throw new ThreadkeeperError("ROUTE_VALIDATION_FAILED", "all-history backfill requires confirmAllHistory: true");
    }
    return presetScope(input);
  }

  if (typeof input !== "object") {
    throw new ThreadkeeperError("ROUTE_VALIDATION_FAILED", "backfill scope must be a preset, positive day count, or inclusive date range");
  }

  const record = input as Record<string, unknown>;
  const kind = record.kind ?? record.type;
  const preset = record.preset ?? record.mode;
  const confirmation = record.confirmAllHistory === true || record.allowAllHistory === true;

  if (isBackfillPreset(preset) || (kind === "preset" && isBackfillPreset(record.value))) {
    const selected = (isBackfillPreset(preset) ? preset : record.value) as BackfillPreset;
    if (selected === "all" && requireAllConfirmation && !confirmation) {
      throw new ThreadkeeperError("ROUTE_VALIDATION_FAILED", "all-history backfill requires confirmAllHistory: true");
    }
    return presetScope(selected);
  }

  const daysValue = record.days ?? record.dayCount;
  if (daysValue !== undefined) {
    if (typeof daysValue !== "number" || !Number.isInteger(daysValue) || daysValue < 1 || daysValue > MAX_CUSTOM_BACKFILL_DAYS) {
      throw new ThreadkeeperError("ROUTE_VALIDATION_FAILED", `backfill days must be a positive integer from 1 to ${MAX_CUSTOM_BACKFILL_DAYS}`);
    }
    return { kind: "days", days: daysValue };
  }

  const startValue = record.startDate ?? record.start;
  const endValue = record.endDate ?? record.end;
  if (startValue !== undefined || endValue !== undefined) {
    const startDate = assertIsoDate(startValue, "startDate");
    const endDate = assertIsoDate(endValue, "endDate");
    if (startDate > endDate) {
      throw new ThreadkeeperError("ROUTE_VALIDATION_FAILED", "backfill startDate must be on or before endDate");
    }
    return { kind: "range", startDate, endDate };
  }

  throw new ThreadkeeperError("ROUTE_VALIDATION_FAILED", "backfill scope must be a preset, positive day count, or inclusive date range");
}

export function normalizeBackfillRequest(input: BackfillScopeInput = {}, options: { requireAllConfirmation?: boolean } = {}): BackfillScope {
  const confirmation = input.confirmAllHistory === true || input.allowAllHistory === true;
  const rawScope = input.scope ?? input.backfillScope;
  if (rawScope !== undefined) {
    return normalizeBackfillScope(
      typeof rawScope === "object" && rawScope !== null ? { ...(rawScope as Record<string, unknown>), confirmAllHistory: confirmation } : rawScope,
      options,
    );
  }
  if (input.mode !== undefined) return normalizeBackfillScope({ preset: input.mode, confirmAllHistory: confirmation }, options);
  if (input.days !== undefined) return normalizeBackfillScope({ days: input.days }, options);
  if (input.startDate !== undefined || input.endDate !== undefined) return normalizeBackfillScope({ startDate: input.startDate, endDate: input.endDate }, options);
  return presetScope("future_only");
}

export function describeBackfillScope(scope: BackfillScope): string {
  switch (scope.kind) {
    case "preset": return scope.preset;
    case "days": return `last ${scope.days} days`;
    case "range": return `${scope.startDate} through ${scope.endDate} (inclusive)`;
  }
}

const PERSISTED_SCOPE_KEY = "active-backfill-scope";

export function readPersistedBackfillScope(db: Database): BackfillScope | null {
  const row = db.query("SELECT value FROM schema_meta WHERE key = ?").get(PERSISTED_SCOPE_KEY) as { value: string } | null;
  if (!row) return null;
  try { return normalizeBackfillScope(JSON.parse(row.value), { requireAllConfirmation: false }); } catch { return null; }
}

export function writePersistedBackfillScope(db: Database, scope: BackfillScope): void {
  db.query("INSERT INTO schema_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    PERSISTED_SCOPE_KEY,
    JSON.stringify(scope),
  );
}
