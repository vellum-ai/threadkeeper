import "../fixtures/plugin-api-mock.ts";
import { beforeEach, describe, expect, test } from "bun:test";
import { resetMockState, mockState } from "../fixtures/plugin-api-mock.ts";
import { freshDb } from "../fixtures/test-db.ts";
import { captureStop } from "../../src/capture.ts";
import { DEFAULT_CONFIG, setConfig } from "../../src/config.ts";
import stopHook from "../../hooks/stop.ts";
import type { PluginLogger, StopContext } from "@vellumai/plugin-api";

function fakeLogger(): PluginLogger {
  const noop = () => undefined;
  return { info: noop, warn: noop, error: noop, debug: noop, trace: noop, fatal: noop, child: () => fakeLogger() } as unknown as PluginLogger;
}

function fakeStopContext(conversationId: string): StopContext {
  return {
    conversationId,
    messages: [],
    exitReason: "no_tool_calls",
    error: undefined,
    logger: fakeLogger(),
    broadcast: () => undefined,
  } as unknown as StopContext;
}

describe("capture (stop hook)", () => {
  beforeEach(() => {
    resetMockState();
    setConfig(DEFAULT_CONFIG);
    freshDb();
  });

  test("one call creates exactly one dirty_conversations row", () => {
    const db = freshDb();
    captureStop("conv-1", null);
    const rows = db.query(`SELECT * FROM dirty_conversations`).all() as Array<{ conversation_id: string; touched_at: number }>;
    expect(rows.length).toBe(1);
    expect(rows[0]!.conversation_id).toBe("conv-1");
  });

  test("repeated stop events leave one dirty row with a newer timestamp", () => {
    const db = freshDb();
    captureStop("conv-1", null);
    const first = db.query(`SELECT touched_at FROM dirty_conversations WHERE conversation_id = 'conv-1'`).get() as { touched_at: number };
    captureStop("conv-1", null);
    const rows = db.query(`SELECT * FROM dirty_conversations`).all();
    expect(rows.length).toBe(1);
    const second = db.query(`SELECT touched_at FROM dirty_conversations WHERE conversation_id = 'conv-1'`).get() as { touched_at: number };
    expect(second.touched_at).toBeGreaterThanOrEqual(first.touched_at);
  });

  test("capture disabled short-circuits without touching the database", () => {
    const db = freshDb();
    setConfig({ ...DEFAULT_CONFIG, captureEnabled: false });
    captureStop("conv-1", null);
    const rows = db.query(`SELECT * FROM dirty_conversations`).all();
    expect(rows.length).toBe(0);
  });

  test("hook performs no inference or broad history reads", async () => {
    await stopHook(fakeStopContext("conv-1"));
    expect(mockState.calls.getMessages).toBe(0);
    expect(mockState.calls.getConfiguredProvider).toBe(0);
  });

  test("the stop hook fails open when the database is unavailable", async () => {
    mockState.workspaceDir = "/dev/null/threadkeeper-unreachable"; // mkdir under this must fail
    // Force the singleton to re-resolve via the (now broken) fallback path.
    const { closeDb } = await import("../../src/db.ts");
    closeDb();
    await expect(stopHook(fakeStopContext("conv-1"))).resolves.toBeUndefined();
  });
});
