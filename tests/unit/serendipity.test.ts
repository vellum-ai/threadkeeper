import "../fixtures/plugin-api-mock.ts";
import { beforeEach, describe, expect, test } from "bun:test";
import { mockState, resetMockState } from "../fixtures/plugin-api-mock.ts";
import { freshDb } from "../fixtures/test-db.ts";
import { DEFAULT_CONFIG } from "../../src/config.ts";
import { getDb } from "../../src/db.ts";
import { indexOwner } from "../../src/index-doc.ts";
import { addThreadMembership, createThread, insertOpenLoop } from "../../src/repositories/projections.ts";
import { listConnections } from "../../src/repositories/review.ts";
import { runReviewAction } from "../../src/actions.ts";
import { runSerendipitySweep } from "../../src/serendipity.ts";

const VALID_EXPLANATION = JSON.stringify({ relation_type: "reuse", explanation: "Both reuse a five-point structure.", why_it_may_matter_now: "Could speed up drafting." });

function seedThread(title: string, description: string, conversationId: string, withOpenLoop = true) {
  const db = getDb();
  const thread = createThread(db, title, description);
  addThreadMembership(db, thread.id, "conversation", conversationId, "source", 0.9);
  if (withOpenLoop) {
    insertOpenLoop(db, { threadId: thread.id, description, nextAction: null, dueAt: null, originType: "direct", confidence: 0.9, createdFromArtifactId: null });
  }
  return thread;
}

describe("serendipity engine", () => {
  beforeEach(() => {
    resetMockState();
    freshDb();
    mockState.providerImpl = () => VALID_EXPLANATION;
  });

  test("same-source overlap is excluded — not independent corroboration", async () => {
    const a = seedThread("Northstar newsletter", "Weekly newsletter about developments and analysis with five items and recommended actions", "conv-shared");
    const b = seedThread("Northstar research notes", "Weekly research analysis with developments and five recommended actions summary", "conv-shared");
    await indexOwner("thread", b.id, "Weekly research analysis with developments and five recommended actions summary");

    const summary = await runSerendipitySweep([a.id], DEFAULT_CONFIG);
    expect(summary.connectionsCreated).toBe(0);
  });

  test("generic short overlap does not pass the minimum score threshold", async () => {
    const a = seedThread("A", "ok", "conv-a", false);
    const b = seedThread("B", "ok", "conv-b", false);
    await indexOwner("thread", b.id, "B. ok");

    const summary = await runSerendipitySweep([a.id], DEFAULT_CONFIG);
    expect(summary.connectionsCreated).toBe(0);
  });

  test("sensitive categories are excluded by default", async () => {
    const a = seedThread("Health check-in", "Ongoing health and therapy notes about a recurring appointment schedule", "conv-a");
    const b = seedThread("Therapy planning", "Therapy and health scheduling notes about a recurring appointment plan", "conv-b");
    await indexOwner("thread", b.id, "Therapy and health scheduling notes about a recurring appointment plan");

    expect(DEFAULT_CONFIG.serendipity.sensitiveCategoriesEnabled).toBe(false);
    const summary = await runSerendipitySweep([a.id], DEFAULT_CONFIG);
    expect(summary.connectionsCreated).toBe(0);
  });

  test("a useful cross-thread connection is created with evidence-bearing endpoints", async () => {
    const a = seedThread(
      "Northstar newsletter",
      "Newsletter issue structure with five key developments why they matter and one recommended action for readers",
      "conv-a",
    );
    const b = seedThread(
      "Client briefing workflow",
      "Client briefing structure with five key developments why they matter and one recommended action for the client",
      "conv-b",
    );
    await indexOwner(
      "thread",
      b.id,
      "Client briefing structure with five key developments why they matter and one recommended action for the client",
    );

    const summary = await runSerendipitySweep([a.id], DEFAULT_CONFIG);
    expect(summary.connectionsCreated).toBe(1);
    const db = getDb();
    const connections = listConnections(db, "pending", 10);
    expect(connections.length).toBe(1);
    expect(connections[0]!.relation_type).toBe("reuse");
  });

  test("a dismissed connection respects its suppression cooldown", async () => {
    const a = seedThread(
      "Northstar newsletter",
      "Newsletter issue structure with five key developments why they matter and one recommended action for readers",
      "conv-a",
    );
    const b = seedThread(
      "Client briefing workflow",
      "Client briefing structure with five key developments why they matter and one recommended action for the client",
      "conv-b",
    );
    await indexOwner(
      "thread",
      b.id,
      "Client briefing structure with five key developments why they matter and one recommended action for the client",
    );

    await runSerendipitySweep([a.id], DEFAULT_CONFIG);
    const db = getDb();
    const [connection] = listConnections(db, "pending", 10);
    expect(connection).toBeTruthy();
    runReviewAction(db, { action: "dismiss_connection", targetId: connection!.id, reason: "not useful" });

    const second = await runSerendipitySweep([a.id], DEFAULT_CONFIG);
    expect(second.connectionsCreated).toBe(0);
  });

  test("candidate count stays bounded by maxCandidatesPerRun", async () => {
    const db = getDb();
    const config = { ...DEFAULT_CONFIG, serendipity: { ...DEFAULT_CONFIG.serendipity, maxCandidatesPerRun: 2, minimumScore: 0.1 } };
    const a = seedThread("Hub thread", "A specific and detailed hub thread about many recurring project ideas and structures", "conv-hub");
    for (let i = 0; i < 6; i++) {
      const other = seedThread(`Candidate ${i}`, `A specific and detailed candidate thread number ${i} about many recurring project ideas`, `conv-${i}`);
      await indexOwner("thread", other.id, `A specific and detailed candidate thread number ${i} about many recurring project ideas`);
    }
    const summary = await runSerendipitySweep([a.id], config);
    expect(summary.connectionsCreated).toBeLessThanOrEqual(2);
    expect(listConnections(db, "pending", 50).length).toBeLessThanOrEqual(2);
  });
});
