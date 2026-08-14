import "../fixtures/plugin-api-mock.ts";
import { beforeEach, describe, expect, test } from "bun:test";
import { addMockMessage, mockState, resetMockState } from "../fixtures/plugin-api-mock.ts";
import { freshDb } from "../fixtures/test-db.ts";
import { captureStop } from "../../src/capture.ts";
import { DEFAULT_CONFIG, setConfig } from "../../src/config.ts";
import { getDb } from "../../src/db.ts";
import { ingestConversation } from "../../src/ingestion.ts";
import { indexOwner } from "../../src/index-doc.ts";
import { addThreadMembership, createThread, insertOpenLoop } from "../../src/repositories/projections.ts";
import { runSerendipitySweep } from "../../src/serendipity.ts";

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx]!;
}

describe("performance invariants", () => {
  beforeEach(() => {
    resetMockState();
    freshDb();
    setConfig(DEFAULT_CONFIG);
  });

  test("stop hook p95 is well under the 20ms live-path target on a warm database", () => {
    captureStop("warmup", null); // warm the SQLite file/page cache
    const durations: number[] = [];
    for (let i = 0; i < 200; i++) {
      const start = performance.now();
      captureStop(`conv-${i % 20}`, null); // realistic mix of repeat + new conversations
      durations.push(performance.now() - start);
    }
    durations.sort((a, b) => a - b);
    expect(percentile(durations, 0.95)).toBeLessThan(20);
  });

  test("ingestion stays bounded on a conversation with many stored messages", async () => {
    for (let i = 0; i < 500; i++) addMockMessage("big-conv", "user", `message number ${i}`, 1000 + i);
    const result = await ingestConversation("big-conv", DEFAULT_CONFIG.maxMessagesPerConversationRun);
    expect(result.newRevisions.length).toBeLessThanOrEqual(DEFAULT_CONFIG.maxMessagesPerConversationRun);
    expect(result.hasMore).toBe(true);
  });

  test("serendipity candidate generation stays bounded and fast with many dormant threads", async () => {
    mockState.providerImpl = () => JSON.stringify({ relation_type: "reuse", explanation: "shared structure", why_it_may_matter_now: "now" });
    const db = getDb();
    const hub = createThread(db, "Hub project", "A specific detailed hub about recurring structured ideas");
    addThreadMembership(db, hub.id, "conversation", "conv-hub", "source", 0.9);
    insertOpenLoop(db, { threadId: hub.id, description: "A specific detailed hub about recurring structured ideas", nextAction: null, dueAt: null, originType: "direct", confidence: 0.9, createdFromArtifactId: null });

    for (let i = 0; i < 50; i++) {
      const other = createThread(db, `Dormant idea ${i}`, `A specific detailed dormant idea ${i} about recurring structured ideas`);
      addThreadMembership(db, other.id, "conversation", `conv-${i}`, "source", 0.9);
      await indexOwner("thread", other.id, `A specific detailed dormant idea ${i} about recurring structured ideas`);
    }

    const start = performance.now();
    const summary = await runSerendipitySweep([hub.id], { ...DEFAULT_CONFIG, serendipity: { ...DEFAULT_CONFIG.serendipity, minimumScore: 0.1 } });
    const elapsed = performance.now() - start;

    expect(summary.connectionsCreated).toBeLessThanOrEqual(DEFAULT_CONFIG.serendipity.maxCandidatesPerRun);
    expect(elapsed).toBeLessThan(2000);
  });
});
