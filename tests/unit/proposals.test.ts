import "../fixtures/plugin-api-mock.ts";
import { beforeEach, describe, expect, test } from "bun:test";
import { addMockMessage, mockState, resetMockState } from "../fixtures/plugin-api-mock.ts";
import { freshDb } from "../fixtures/test-db.ts";
import { runReviewAction } from "../../src/actions.ts";
import { DEFAULT_CONFIG, setConfig } from "../../src/config.ts";
import { getDb } from "../../src/db.ts";
import { runExtraction, type ExtractOutcome } from "../../src/extraction.ts";
import { ingestConversation } from "../../src/ingestion.ts";
import { materializeExtraction } from "../../src/policy.ts";
import { listOpenLoops } from "../../src/repositories/projections.ts";
import { listProposals } from "../../src/repositories/review.ts";

type OkOutcome = Extract<ExtractOutcome, { status: "ok" }>;

/** Ingest whatever mock messages are pending for `conversationId`, then extract using a payload
 * built from the real ingested message id (avoids hand-guessing ids before they exist). */
async function extract(conversationId: string, buildPayload: (messageId: string) => unknown): Promise<OkOutcome> {
  const batch = await ingestConversation(conversationId, 100);
  const messageId = batch.newRevisions[batch.newRevisions.length - 1]!.messageId;
  mockState.providerImpl = () => JSON.stringify(buildPayload(messageId));
  const outcome = await runExtraction(conversationId, batch.newRevisions, DEFAULT_CONFIG);
  expect(outcome.status).toBe("ok");
  return outcome as OkOutcome;
}

const empty = { turn_summary: "", thread_candidates: [], events: [], open_loop_candidates: [], claim_candidates: [], closure_candidates: [] };

describe("proposals and projection policy", () => {
  beforeEach(() => {
    resetMockState();
    freshDb();
    setConfig(DEFAULT_CONFIG);
  });

  test("a direct open loop materializes immediately; an inferred one becomes a proposal", async () => {
    addMockMessage("conv-1", "user", "I need to buy the domain. Maybe I'll eventually write a retro.", 1000);
    const outcome = await extract("conv-1", (messageId) => ({
      ...empty,
      open_loop_candidates: [
        { description: "Buy the domain", next_action: null, due_at: null, origin: "direct", source_message_ids: [messageId], confidence: 0.9 },
        { description: "Write a retro eventually", next_action: null, due_at: null, origin: "inferred", source_message_ids: [messageId], confidence: 0.4 },
      ],
    }));
    const db = getDb();
    materializeExtraction("conv-1", outcome, DEFAULT_CONFIG);
    expect(listOpenLoops(db, "all", 50).length).toBe(1);
    expect(listProposals(db, "pending", 50).filter((p) => p.proposal_type === "create_open_loop").length).toBe(1);
  });

  test("claims are always proposals; accepting one materializes an active claim", async () => {
    addMockMessage("conv-1", "user", "I prefer a monthly cadence.", 1000);
    const outcome = await extract("conv-1", (messageId) => ({
      ...empty,
      claim_candidates: [
        { subject: "user", predicate: "prefers_cadence", object: "monthly", epistemic_type: "direct_fact", temporal_status: "current", source_message_ids: [messageId], confidence: 0.9, sensitive: false },
      ],
    }));
    const db = getDb();
    materializeExtraction("conv-1", outcome, DEFAULT_CONFIG);
    expect((db.query(`SELECT COUNT(*) as n FROM claims`).get() as { n: number }).n).toBe(0);
    const proposals = listProposals(db, "pending", 50);
    expect(proposals.length).toBe(1);
    expect(proposals[0]!.proposal_type).toBe("create_claim");

    const result = runReviewAction(db, { action: "accept_proposal", targetId: proposals[0]!.id }) as { createdClaimId: string };
    expect(result.createdClaimId).toBeTruthy();
    expect((db.query(`SELECT status FROM claims WHERE id = ?`).get(result.createdClaimId) as { status: string }).status).toBe("active");
  });

  test("rejected fingerprint does not reappear without new evidence", async () => {
    addMockMessage("conv-1", "user", "Maybe I'll eventually write a retro.", 1000);
    const outcome = await extract("conv-1", (messageId) => ({
      ...empty,
      open_loop_candidates: [{ description: "Write a retro eventually", next_action: null, due_at: null, origin: "inferred", source_message_ids: [messageId], confidence: 0.4 }],
    }));
    const db = getDb();
    materializeExtraction("conv-1", outcome, DEFAULT_CONFIG);
    const first = listProposals(db, "pending", 50);
    expect(first.length).toBe(1);

    runReviewAction(db, { action: "reject_proposal", targetId: first[0]!.id, reason: "not useful" });
    expect(listProposals(db, "pending", 50).length).toBe(0);

    // Re-running the identical extraction must not resurrect a suppressed proposal.
    materializeExtraction("conv-1", outcome, DEFAULT_CONFIG);
    expect(listProposals(db, "pending", 50).length).toBe(0);
  });

  test("materially new evidence for the same subject/predicate creates a superseding proposal", async () => {
    addMockMessage("conv-1", "user", "I prefer weekly.", 1000);
    const first = await extract("conv-1", (messageId) => ({
      ...empty,
      claim_candidates: [{ subject: "user", predicate: "prefers_cadence", object: "weekly", epistemic_type: "direct_fact", temporal_status: "current", source_message_ids: [messageId], confidence: 0.9, sensitive: false }],
    }));
    const db = getDb();
    materializeExtraction("conv-1", first, DEFAULT_CONFIG);
    const createProposalRow = listProposals(db, "pending", 50)[0]!;
    const accepted = runReviewAction(db, { action: "accept_proposal", targetId: createProposalRow.id }) as { createdClaimId: string };
    expect((db.query(`SELECT status FROM claims WHERE id = ?`).get(accepted.createdClaimId) as { status: string }).status).toBe("active");

    addMockMessage("conv-1", "user", "Actually, monthly is better.", 2000);
    const second = await extract("conv-1", (messageId) => ({
      ...empty,
      claim_candidates: [{ subject: "user", predicate: "prefers_cadence", object: "monthly", epistemic_type: "direct_fact", temporal_status: "current", source_message_ids: [messageId], confidence: 0.9, sensitive: false }],
    }));
    materializeExtraction("conv-1", second, DEFAULT_CONFIG);

    const pending = listProposals(db, "pending", 50);
    expect(pending.some((p) => p.proposal_type === "supersede_claim")).toBe(true);
  });

  test("direct completion closes the matching open loop; an ambiguous one only proposes closure", async () => {
    addMockMessage("conv-1", "user", "I need to buy the domain.", 1000);
    const first = await extract("conv-1", (messageId) => ({
      ...empty,
      open_loop_candidates: [{ description: "Buy the domain", next_action: null, due_at: null, origin: "direct", source_message_ids: [messageId], confidence: 0.9 }],
    }));
    const db = getDb();
    materializeExtraction("conv-1", first, DEFAULT_CONFIG);
    expect(listOpenLoops(db, "open", 50).length).toBe(1);

    addMockMessage("conv-1", "user", "I bought the domain.", 2000);
    const closure = await extract("conv-1", (messageId) => ({
      ...empty,
      closure_candidates: [{ description: "Bought the domain", source_message_ids: [messageId], confidence: 0.9 }],
    }));
    materializeExtraction("conv-1", closure, DEFAULT_CONFIG);
    expect(listOpenLoops(db, "open", 50).length).toBe(0);
    expect(listOpenLoops(db, "done", 50).length).toBe(1);

    // A second, unrelated open loop plus an unrelated closure candidate must remain open + proposal-only.
    addMockMessage("conv-1", "user", "I need to write issue zero.", 3000);
    const secondLoop = await extract("conv-1", (messageId) => ({
      ...empty,
      open_loop_candidates: [{ description: "Write issue zero", next_action: null, due_at: null, origin: "direct", source_message_ids: [messageId], confidence: 0.9 }],
    }));
    materializeExtraction("conv-1", secondLoop, DEFAULT_CONFIG);

    addMockMessage("conv-1", "user", "Something unrelated happened at work today.", 4000);
    const unrelatedClosure = await extract("conv-1", (messageId) => ({
      ...empty,
      closure_candidates: [{ description: "Something unrelated happened at work today", source_message_ids: [messageId], confidence: 0.5 }],
    }));
    materializeExtraction("conv-1", unrelatedClosure, DEFAULT_CONFIG);

    expect(listOpenLoops(db, "open", 50).some((l) => l.description === "Write issue zero")).toBe(true);
    expect(listProposals(db, "pending", 50).some((p) => p.proposal_type === "close_loop")).toBe(true);
  });
});
