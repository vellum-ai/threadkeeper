import "../fixtures/plugin-api-mock.ts";
import { beforeEach, describe, expect, test } from "bun:test";
import { mockState, resetMockState } from "../fixtures/plugin-api-mock.ts";
import { freshDb } from "../fixtures/test-db.ts";
import { normalizeBackfillRequest, normalizeBackfillScope } from "../../src/backfillScope.ts";
import { startBackfill } from "../../src/backfill.ts";
import { DEFAULT_CONFIG, setConfig } from "../../src/config.ts";
import { getDb } from "../../src/db.ts";
import { startBackfill as enqueueBackfill } from "../../src/index.ts";

function conversation(id: string, updatedAt: number) {
  return { id, title: id, createdAt: updatedAt, updatedAt };
}

describe("dynamic backfill scopes", () => {
  beforeEach(() => {
    resetMockState();
    freshDb();
    setConfig(DEFAULT_CONFIG);
  });

  test("keeps fixed presets compatible and accepts a positive custom day count", () => {
    expect(normalizeBackfillScope("last_90_days")).toEqual({ kind: "preset", preset: "last_90_days" });
    expect(normalizeBackfillRequest({ days: 45 })).toEqual({ kind: "days", days: 45 });
  });

  test("accepts an inclusive ISO date range and rejects malformed or reversed ranges", () => {
    expect(normalizeBackfillRequest({ startDate: "2026-01-01", endDate: "2026-01-31" })).toEqual({
      kind: "range", startDate: "2026-01-01", endDate: "2026-01-31",
    });
    expect(() => normalizeBackfillRequest({ startDate: "2026-02-01", endDate: "2026-01-31" })).toThrow("on or before");
    expect(() => normalizeBackfillRequest({ startDate: "2026-02-30", endDate: "2026-03-01" })).toThrow("valid calendar date");
  });

  test("requires explicit confirmation for unsafe all-history processing", () => {
    expect(() => normalizeBackfillRequest({ mode: "all" })).toThrow("confirmAllHistory");
    expect(normalizeBackfillRequest({ mode: "all", confirmAllHistory: true })).toEqual({ kind: "preset", preset: "all" });
  });

  test("filters by custom days and inclusive date endpoints", async () => {
    const now = Date.parse("2026-08-13T12:00:00.000Z");
    mockState.conversations = [
      conversation("inside-days", now - 10 * 24 * 60 * 60 * 1000),
      conversation("outside-days", now - 31 * 24 * 60 * 60 * 1000),
    ];
    const daysResult = await startBackfill({ days: 30 }, now);
    expect(daysResult.enqueued).toBe(1);

    resetMockState();
    freshDb();
    mockState.conversations = [
      conversation("range-start", Date.parse("2026-01-01T00:00:00.000Z")),
      conversation("range-end", Date.parse("2026-01-31T23:59:59.999Z")),
      conversation("range-before", Date.parse("2025-12-31T23:59:59.999Z")),
      conversation("range-after", Date.parse("2026-02-01T00:00:00.000Z")),
    ];
    const rangeResult = await startBackfill({ startDate: "2026-01-01", endDate: "2026-01-31" }, now);
    expect(rangeResult.enqueued).toBe(2);
    expect((getDb().query("SELECT COUNT(*) as n FROM dirty_conversations").get() as { n: number }).n).toBe(2);
  });

  test("caps one scan at 5,000 conversations so all-history remains bounded", async () => {
    mockState.conversations = Array.from({ length: 5_001 }, (_, i) => conversation(`conv-${i}`, 1));
    const result = await startBackfill({ kind: "preset", preset: "all" });
    expect(result.enqueued).toBe(5_000);
    expect(result.bounded).toBe(true);
  });

  test("public action path refuses all history without confirmation and accepts a later changed scope", async () => {
    await expect(enqueueBackfill({ mode: "all" })).rejects.toThrow("confirmAllHistory");
    const accepted = await enqueueBackfill({ days: 12 });
    expect((accepted as { ok: boolean }).ok).toBe(true);
  });
});
