import "../fixtures/plugin-api-mock.ts";
import { beforeEach, describe, expect, test } from "bun:test";
import { mockState, resetMockState } from "../fixtures/plugin-api-mock.ts";
import { freshDb } from "../fixtures/test-db.ts";
import { DEFAULT_CONFIG, setConfig } from "../../src/config.ts";
import { getDb } from "../../src/db.ts";
import { insertArtifact, insertEvidenceEdge, insertSourceRevision, upsertSource } from "../../src/repositories/evidence.ts";
import { addThreadMembership, createThread, insertOpenLoop } from "../../src/repositories/projections.ts";
import { createProposal } from "../../src/repositories/review.ts";

import * as statusRoute from "../../routes/status.ts";
import * as threadsRoute from "../../routes/threads.ts";
import * as threadRoute from "../../routes/thread.ts";
import * as openLoopsRoute from "../../routes/open-loops.ts";
import * as reviewRoute from "../../routes/review.ts";
import * as actionRoute from "../../routes/action.ts";
import * as jobsRoute from "../../routes/jobs.ts";

function seedThread() {
  const db = getDb();
  mockState.conversations = [{ id: "conv-1", title: "Northstar launch notes", createdAt: 1_700_000_000_000, updatedAt: 1_700_000_100_000 }];
  const source = upsertSource(db, { sourceType: "conversation_message", stableLocator: "msg-1", conversationId: "conv-1", messageId: "msg-1", role: "user", sourceTimestamp: 1_700_000_050_000 });
  const revision = insertSourceRevision(db, { sourceId: source.id, contentHash: "route-evidence", capturedAt: 1_700_000_060_000, contentLength: 48, excerpt: "The Northstar landing page still needs to be published.", canonicalText: "The Northstar landing page still needs to be published." });
  const run = db.query(`INSERT INTO pipeline_runs(id, pipeline_name, pipeline_version, prompt_version, model_name, config_hash, started_at, status, input_fingerprint) VALUES ('run-route', 'extract', '1', null, null, 'cfg', 1, 'succeeded', 'route-input') RETURNING *`).get() as { id: string };
  const artifact = insertArtifact(db, { runId: run.id, artifactType: "open_loop_candidate", payload: {}, epistemicType: "intent", extractorConfidence: 0.9 });
  insertEvidenceEdge(db, artifact.id, revision.id, "supports", null, 0.9);
  const thread = createThread(db, "Northstar", "Newsletter launch");
  addThreadMembership(db, thread.id, "conversation", "conv-1", "source", 0.9);
  insertOpenLoop(db, { threadId: thread.id, description: "Publish the landing page", nextAction: "Publish the Northstar page", dueAt: null, originType: "direct", confidence: 0.9, createdFromArtifactId: artifact.id });
  const proposal = createProposal(db, {
    proposalType: "create_open_loop",
    targetType: "thread",
    targetId: thread.id,
    operation: "create",
    payload: { description: "Draft issue two", nextAction: "Write the outline", artifactId: artifact.id },
    fingerprint: "route-test-fp-1",
    confidence: { extraction: 0.8, evidence_quality: 0.7, source_independence: 1, recency: 1, user_confirmation: 0, contradiction_penalty: 0, risk: "medium" },
    createdByRunId: null,
    expiresAt: null,
  });
  return { thread, proposal: proposal.row };
}

describe("plugin routes", () => {
  beforeEach(() => {
    resetMockState();
    freshDb();
    setConfig(DEFAULT_CONFIG);
  });

  test("GET status returns 200 with a structured status body", async () => {
    seedThread();
    const response = await statusRoute.GET();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.threadCount).toBe(1);
    expect(body.openLoopCount).toBe(1);
  });

  test("GET threads validates the status filter and returns shaped items", async () => {
    seedThread();
    const bad = await threadsRoute.GET(new Request("http://local/x/plugins/threadkeeper/threads?status=not-a-status"));
    expect(bad.status).toBe(400);

    const good = await threadsRoute.GET(new Request("http://local/x/plugins/threadkeeper/threads?status=active&limit=10"));
    expect(good.status).toBe(200);
    const body = await good.json();
    expect(body.items.length).toBe(1);
    expect(body.items[0].title).toBe("Northstar");
  });

  test("GET thread requires a well-formed id", async () => {
    const bad = await threadRoute.GET(new Request("http://local/x/plugins/threadkeeper/thread?id=x"));
    expect(bad.status).toBe(400);

    const { thread } = seedThread();
    const good = await threadRoute.GET(new Request(`http://local/x/plugins/threadkeeper/thread?id=${thread.id}`));
    expect(good.status).toBe(200);
    const body = await good.json();
    expect(body.openLoops.length).toBe(1);
  });

  test("GET open-loops filters by status", async () => {
    seedThread();
    const response = await openLoopsRoute.GET(new Request("http://local/x/plugins/threadkeeper/open-loops?status=open&limit=10"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items.length).toBe(1);
    expect(body.items[0].title).toBe("Publish the landing page");
    expect(body.items[0].sources[0].conversationTitle).toBe("Northstar launch notes");
    expect(body.items[0].sources[0].excerpt).toContain("still needs to be published");
    expect(body.items[0].sources[0].locator).toBe("msg-1");
  });

  test("GET review lists pending proposals", async () => {
    seedThread();
    const response = await reviewRoute.GET(new Request("http://local/x/plugins/threadkeeper/review?type=proposal&limit=10"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items.length).toBe(1);
    expect(body.items[0].title).toBe("Add open loop: Draft issue two");
    expect(body.items[0].nextAction).toBe("Write the outline");
    expect(body.items[0].impact).toBe("Creates a new open loop.");
    expect(body.items[0].sources[0].conversationTitle).toBe("Northstar launch notes");
    expect(body.items[0].sources[0].label).toContain("Northstar launch notes");
    expect(body.items[0].confidence).toBeGreaterThan(0);
  });

  test("POST action rejects an unsupported action name", async () => {
    const response = await actionRoute.POST(
      new Request("http://local/x/plugins/threadkeeper/action", { method: "POST", body: JSON.stringify({ action: "delete_everything" }) }),
    );
    expect(response.status).toBe(400);
  });

  test("POST action requires targetId for review actions", async () => {
    const response = await actionRoute.POST(
      new Request("http://local/x/plugins/threadkeeper/action", { method: "POST", body: JSON.stringify({ action: "accept_proposal" }) }),
    );
    expect(response.status).toBe(400);
  });

  test("POST action requires a 2-500 character query for archaeology", async () => {
    const tooShort = await actionRoute.POST(
      new Request("http://local/x/plugins/threadkeeper/action", { method: "POST", body: JSON.stringify({ action: "request_archaeology", query: "x" }) }),
    );
    expect(tooShort.status).toBe(400);
  });

  test("POST action accepts a proposal and returns 202 with a job", async () => {
    const { proposal } = seedThread();
    const response = await actionRoute.POST(
      new Request("http://local/x/plugins/threadkeeper/action", {
        method: "POST",
        body: JSON.stringify({ action: "accept_proposal", targetId: proposal.id }),
      }),
    );
    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.job.status).toBe("succeeded");
  });

  test("GET jobs returns the job created by an accepted action", async () => {
    const { proposal } = seedThread();
    const posted = await actionRoute.POST(
      new Request("http://local/x/plugins/threadkeeper/action", {
        method: "POST",
        body: JSON.stringify({ action: "accept_proposal", targetId: proposal.id }),
      }),
    );
    const { job } = await posted.json();
    const response = await jobsRoute.GET(new Request(`http://local/x/plugins/threadkeeper/jobs?id=${job.jobId}`));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("succeeded");
  });
});
