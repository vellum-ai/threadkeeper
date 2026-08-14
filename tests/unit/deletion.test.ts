import "../fixtures/plugin-api-mock.ts";
import { beforeEach, describe, expect, test } from "bun:test";
import { addMockMessage, mockState, resetMockState } from "../fixtures/plugin-api-mock.ts";
import { freshDb } from "../fixtures/test-db.ts";
import { DEFAULT_CONFIG } from "../../src/config.ts";
import { getDb } from "../../src/db.ts";
import { handleConversationDeleted, handleConversationsCleared } from "../../src/deletion.ts";
import { runExtraction } from "../../src/extraction.ts";
import { ingestConversation } from "../../src/ingestion.ts";
import { materializeExtraction } from "../../src/policy.ts";
import { indexOwner } from "../../src/index-doc.ts";
import { isTombstoned } from "../../src/repositories/audit.ts";
import { markDirty } from "../../src/repositories/queue.ts";

async function seedThreadForConversation(conversationId: string) {
  addMockMessage(conversationId, "user", "I need to buy the domain for Northstar.", 1000);
  const batch = await ingestConversation(conversationId, 100);
  const messageId = batch.newRevisions[0]!.messageId;
  mockState.providerImpl = () =>
    JSON.stringify({
      turn_summary: "",
      thread_candidates: [{ title: "Northstar", summary: "Newsletter launch", existing_thread_hint: null, source_message_ids: [messageId], confidence: 0.9 }],
      events: [],
      open_loop_candidates: [{ description: "Buy the domain", next_action: null, due_at: null, origin: "direct", source_message_ids: [messageId], confidence: 0.9 }],
      claim_candidates: [],
      closure_candidates: [],
    });
  const extraction = await runExtraction(conversationId, batch.newRevisions, DEFAULT_CONFIG);
  if (extraction.status !== "ok") throw new Error("expected ok extraction");
  const summary = materializeExtraction(conversationId, extraction, DEFAULT_CONFIG);
  const threadId = summary.threadIds[0]!;
  await indexOwner("thread", threadId, "Northstar newsletter launch domain", { title: "Northstar" });
  return threadId;
}

describe("deletion propagation", () => {
  beforeEach(() => {
    resetMockState();
    freshDb();
  });

  test("conversation deletion removes dependent sources, revisions, and the thread's index document", async () => {
    const threadId = await seedThreadForConversation("conv-1");
    const db = getDb();
    expect((db.query(`SELECT COUNT(*) as n FROM sources WHERE conversation_id = 'conv-1'`).get() as { n: number }).n).toBeGreaterThan(0);
    expect((db.query(`SELECT COUNT(*) as n FROM index_documents WHERE owner_id = ?`).get(threadId) as { n: number }).n).toBe(1);

    await handleConversationDeleted("conv-1");

    expect((db.query(`SELECT COUNT(*) as n FROM sources WHERE conversation_id = 'conv-1'`).get() as { n: number }).n).toBe(0);
    expect((db.query(`SELECT COUNT(*) as n FROM source_revisions`).get() as { n: number }).n).toBe(0);
    expect((db.query(`SELECT COUNT(*) as n FROM index_documents WHERE owner_id = ?`).get(threadId) as { n: number }).n).toBe(0);
    expect(isTombstoned(db, "conversation", "conv-1")).toBe(true);
    expect(
      db
        .query(
          `SELECT purge_status FROM tombstones WHERE target_type = 'conversation' AND target_id = 'conv-1' ORDER BY deletion_generation DESC LIMIT 1`,
        )
        .get(),
    ).toEqual({ purge_status: "purged" });
  });

  test("a stale queued signal cannot resurrect tombstoned data", async () => {
    await seedThreadForConversation("conv-1");
    const db = getDb();
    await handleConversationDeleted("conv-1");

    // Simulate a stale stop-hook write racing after deletion — this must not resurrect anything.
    markDirty(db, "conv-1", null);
    const result = await ingestConversation("conv-1", 100);
    expect(result.status).toBe("tombstoned");
    expect((db.query(`SELECT COUNT(*) as n FROM sources WHERE conversation_id = 'conv-1'`).get() as { n: number }).n).toBe(0);
  });

  test("repeated cleanup for the same conversation is safe and idempotent", async () => {
    await seedThreadForConversation("conv-1");
    await handleConversationDeleted("conv-1");
    await expect(handleConversationDeleted("conv-1")).resolves.toBeUndefined();
    await expect(handleConversationDeleted("conv-1")).resolves.toBeUndefined();
    const db = getDb();
    expect((db.query(`SELECT COUNT(*) as n FROM sources WHERE conversation_id = 'conv-1'`).get() as { n: number }).n).toBe(0);
  });

  test("clear-all removes every conversation-derived record", async () => {
    await seedThreadForConversation("conv-1");
    await seedThreadForConversation("conv-2");
    const db = getDb();
    expect((db.query(`SELECT COUNT(*) as n FROM threads`).get() as { n: number }).n).toBeGreaterThan(0);

    await handleConversationsCleared();

    for (const table of ["threads", "open_loops", "claims", "proposals", "connections", "sources", "source_revisions", "pipeline_runs", "artifacts", "index_documents", "dirty_conversations"]) {
      const count = (db.query(`SELECT COUNT(*) as n FROM ${table}`).get() as { n: number }).n;
      expect(count).toBe(0);
    }

    await expect(handleConversationsCleared()).resolves.toBeUndefined();
  });
});
