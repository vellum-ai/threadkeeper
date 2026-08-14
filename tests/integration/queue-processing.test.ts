import "../fixtures/plugin-api-mock.ts";
import { beforeEach, describe, expect, test } from "bun:test";
import { addMockMessage, mockState, resetMockState } from "../fixtures/plugin-api-mock.ts";
import { freshDb } from "../fixtures/test-db.ts";
import { captureStop } from "../../src/capture.ts";
import { DEFAULT_CONFIG, setConfig } from "../../src/config.ts";
import { getDb } from "../../src/db.ts";
import { processQueue } from "../../src/queueProcessor.ts";
import { claimJobs, createJob } from "../../src/repositories/queue.ts";
import { listThreads } from "../../src/repositories/projections.ts";

const VALID_PAYLOAD = () =>
  JSON.stringify({
    turn_summary: "",
    thread_candidates: [{ title: "Northstar", summary: "Newsletter", existing_thread_hint: null, source_message_ids: ["placeholder"], confidence: 0.9 }],
    events: [],
    open_loop_candidates: [],
    claim_candidates: [],
    closure_candidates: [],
  });

describe("end-to-end queue processing", () => {
  beforeEach(() => {
    resetMockState();
    freshDb();
    setConfig(DEFAULT_CONFIG);
  });

  test("stop marks a conversation dirty; process_queue ingests, extracts, and materializes it", async () => {
    addMockMessage("conv-1", "user", "I want to launch Northstar, a weekly newsletter.", 1000);
    captureStop("conv-1", null);

    const db = getDb();
    expect((db.query(`SELECT COUNT(*) as n FROM dirty_conversations`).get() as { n: number }).n).toBe(1);

    mockState.providerImpl = () => {
      const messages = mockState.messagesByConversation.get("conv-1")!;
      return JSON.stringify({
        turn_summary: "",
        thread_candidates: [{ title: "Northstar", summary: "Newsletter", existing_thread_hint: null, source_message_ids: [messages[0]!.id], confidence: 0.9 }],
        events: [],
        open_loop_candidates: [],
        claim_candidates: [],
        closure_candidates: [],
      });
    };

    const result = await processQueue(5, DEFAULT_CONFIG);
    expect(result.conversationsProcessed).toBe(1);
    expect((db.query(`SELECT COUNT(*) as n FROM dirty_conversations`).get() as { n: number }).n).toBe(0);
    expect(listThreads(db, "all", 10).length).toBe(1);
  });

  test("a missing provider leaves the conversation retryable, not lost; it succeeds once the provider returns", async () => {
    addMockMessage("conv-1", "user", "Some content to extract from.", 1000);
    captureStop("conv-1", null);
    mockState.providerImpl = null;

    const first = await processQueue(5, DEFAULT_CONFIG);
    expect(first.conversationErrors).toBe(1);
    const db = getDb();
    const dirtyRow = db.query(`SELECT * FROM dirty_conversations WHERE conversation_id = 'conv-1'`).get() as { last_error_code: string; next_attempt_at: number } | null;
    expect(dirtyRow?.last_error_code).toBe("NO_PROVIDER");
    expect(dirtyRow?.next_attempt_at).toBeGreaterThan(Date.now());

    // Force the row eligible again (simulating the backoff elapsing) and restore the provider.
    db.query(`UPDATE dirty_conversations SET next_attempt_at = NULL WHERE conversation_id = 'conv-1'`).run();
    mockState.providerImpl = () => VALID_PAYLOAD().replace('"placeholder"', `"${mockState.messagesByConversation.get("conv-1")![0]!.id}"`);
    const second = await processQueue(5, DEFAULT_CONFIG);
    expect(second.conversationsProcessed).toBe(1);
  });

  test("malformed model JSON is repaired once; still-invalid output fails cleanly without corrupting state", async () => {
    addMockMessage("conv-1", "user", "Some content.", 1000);
    captureStop("conv-1", null);
    let calls = 0;
    mockState.providerImpl = () => {
      calls++;
      if (calls === 1) return "not json at all, sorry";
      return VALID_PAYLOAD().replace('"placeholder"', `"${mockState.messagesByConversation.get("conv-1")![0]!.id}"`);
    };
    const result = await processQueue(5, DEFAULT_CONFIG);
    expect(calls).toBe(2); // one repair attempt
    expect(result.conversationsProcessed).toBe(1);

    // Now a case that fails even after repair.
    resetMockState();
    freshDb();
    addMockMessage("conv-2", "user", "More content.", 1000);
    captureStop("conv-2", null);
    mockState.providerImpl = () => "still not json";
    const failed = await processQueue(5, DEFAULT_CONFIG);
    expect(failed.conversationErrors).toBe(1);
    const db = getDb();
    expect((db.query(`SELECT COUNT(*) as n FROM artifacts`).get() as { n: number }).n).toBe(0);
  });

  test("a private-index write failure never blocks the canonical SQLite commit", async () => {
    addMockMessage("conv-1", "user", "Northstar newsletter launch.", 1000);
    captureStop("conv-1", null);
    mockState.providerImpl = () => VALID_PAYLOAD().replace('"placeholder"', `"${mockState.messagesByConversation.get("conv-1")![0]!.id}"`);
    mockState.indexShouldFail = true;

    const result = await processQueue(5, DEFAULT_CONFIG);
    expect(result.conversationsProcessed).toBe(1); // SQLite materialization still committed
    const db = getDb();
    expect((db.query(`SELECT COUNT(*) as n FROM threads`).get() as { n: number }).n).toBe(1);
    expect((db.query(`SELECT COUNT(*) as n FROM index_documents`).get() as { n: number }).n).toBe(0); // index write was dropped, not silently faked
  });

  test("concurrent claim attempts against the same job only let one worker win", () => {
    const db = getDb();
    const job = createJob(db, { jobType: "rebuild_index", input: {}, idempotencyKey: "concurrent-test" });
    const first = claimJobs(db, 60_000, 5);
    const second = claimJobs(db, 60_000, 5);
    expect(first.some((j) => j.id === job.id)).toBe(true);
    expect(second.some((j) => j.id === job.id)).toBe(false);
  });
});
