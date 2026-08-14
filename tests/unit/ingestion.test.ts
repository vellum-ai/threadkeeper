import "../fixtures/plugin-api-mock.ts";
import { beforeEach, describe, expect, test } from "bun:test";
import { addMockMessage, resetMockState, mockState } from "../fixtures/plugin-api-mock.ts";
import { freshDb } from "../fixtures/test-db.ts";
import { ingestConversation } from "../../src/ingestion.ts";
import { advanceCursor, getCursor } from "../../src/repositories/queue.ts";
import { getDb } from "../../src/db.ts";

describe("ingestion", () => {
  beforeEach(() => {
    resetMockState();
    freshDb();
  });

  test("a fixture conversation is ingested exactly once", async () => {
    addMockMessage("conv-1", "user", "I want to launch Northstar.", 1000);
    addMockMessage("conv-1", "assistant", "Got it.", 1001);
    const first = await ingestConversation("conv-1", 100);
    expect(first.status).toBe("ok");
    expect(first.newRevisions.length).toBe(2);

    // Simulate the queue processor advancing the cursor after artifacts commit.
    advanceCursor(getDb(), "conv-1", first.lastMessageId!);

    const second = await ingestConversation("conv-1", 100);
    expect(second.status).toBe("no_changes");
    expect(second.newRevisions.length).toBe(0);
  });

  test("new messages after a valid cursor are processed once", async () => {
    addMockMessage("conv-1", "user", "First message.", 1000);
    const first = await ingestConversation("conv-1", 100);
    advanceCursor(getDb(), "conv-1", first.lastMessageId!);

    addMockMessage("conv-1", "user", "Second message.", 2000);
    const second = await ingestConversation("conv-1", 100);
    expect(second.status).toBe("ok");
    expect(second.newRevisions.length).toBe(1);
    expect(second.newRevisions[0]!.text).toBe("Second message.");
  });

  test("unfinalized messages are skipped", async () => {
    addMockMessage("conv-1", "user", "Finalized.", 1000);
    addMockMessage("conv-1", "assistant", "Still streaming...", 1001, { finalized: 0 });
    const result = await ingestConversation("conv-1", 100);
    expect(result.newRevisions.length).toBe(1);
    expect(result.newRevisions[0]!.text).toBe("Finalized.");
  });

  test("missing cursor message triggers safe full reconciliation", async () => {
    addMockMessage("conv-1", "user", "A", 1000, { id: "m1" });
    addMockMessage("conv-1", "user", "B", 2000, { id: "m2" });
    const first = await ingestConversation("conv-1", 100);
    advanceCursor(getDb(), "conv-1", first.lastMessageId!);

    // Simulate the cursor's anchor message becoming unrecognizable (edit/fork/rewrite).
    const db = getDb();
    db.query(`UPDATE conversation_cursors SET last_processed_message_id = 'does-not-exist' WHERE conversation_id = 'conv-1'`).run();

    const result = await ingestConversation("conv-1", 100);
    expect(result.status).toBe("ok");
    expect(result.newRevisions.length).toBe(2); // reconciles every finalized message
    const cursor = getCursor(db, "conv-1");
    expect(cursor?.full_rescan_required).toBe(1);
  });

  test("edited content creates a new source revision; identical content is idempotent", async () => {
    addMockMessage("conv-1", "user", "Original text.", 1000, { id: "m1" });
    const first = await ingestConversation("conv-1", 100);
    expect(first.newRevisions.length).toBe(1);
    const firstRevisionId = first.newRevisions[0]!.revision.id;

    // Re-ingest the exact same content without advancing the cursor: idempotent, same revision id.
    const again = await ingestConversation("conv-1", 100);
    expect(again.newRevisions.length).toBe(1);
    expect(again.newRevisions[0]!.revision.id).toBe(firstRevisionId);

    // Now "edit" the message (same id, new text) — a genuinely new revision must be created.
    mockState.messagesByConversation.set("conv-1", []);
    addMockMessage("conv-1", "user", "Edited text.", 1000, { id: "m1" });
    const edited = await ingestConversation("conv-1", 100);
    expect(edited.newRevisions.length).toBe(1);
    expect(edited.newRevisions[0]!.revision.id).not.toBe(firstRevisionId);
  });

  test("cursor does not advance on ingestion alone — only the caller advances it after commit", async () => {
    addMockMessage("conv-1", "user", "Hello.", 1000);
    await ingestConversation("conv-1", 100);
    const cursor = getCursor(getDb(), "conv-1");
    expect(cursor?.last_processed_message_id ?? null).toBeNull();
  });

  test("a batch larger than the bound leaves the remainder for the next round", async () => {
    for (let i = 0; i < 5; i++) addMockMessage("conv-1", "user", `msg ${i}`, 1000 + i);
    const result = await ingestConversation("conv-1", 2);
    expect(result.newRevisions.length).toBe(2);
    expect(result.hasMore).toBe(true);
  });
});
