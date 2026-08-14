import "../fixtures/plugin-api-mock.ts";
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshDb } from "../fixtures/test-db.ts";
import { resetDemoDbForTests } from "../../src/demoDb.ts";
import { DEMO_IDS } from "../../src/demoSeed.ts";
import { createThread } from "../../src/repositories/projections.ts";
import * as statusRoute from "../../routes/status.ts";
import * as threadsRoute from "../../routes/threads.ts";
import * as openLoopsRoute from "../../routes/open-loops.ts";
import * as reviewRoute from "../../routes/review.ts";
import * as actionRoute from "../../routes/action.ts";
import * as resetRoute from "../../routes/demo-reset.ts";

function count(db: ReturnType<typeof freshDb>, table: string): number { return (db.query(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n; }

describe("isolated Operator Week demo routes", () => {
  beforeEach(() => {
    freshDb();
    resetDemoDbForTests(join(mkdtempSync(join(tmpdir(), "threadkeeper-demo-test-")), "demo.sqlite"));
  });

  test("live remains the default dataset", async () => {
    const live = freshDb(); createThread(live, "Live-only project", "Must never appear in demo");
    const response = await threadsRoute.GET(new Request("http://local/threads?status=all"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items.map((item: any) => item.title)).toEqual(["Live-only project"]);
  });

  test("demo status has deterministic presentation counts", async () => {
    const response = await statusRoute.GET(new Request("http://local/status?dataset=demo"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ dataset: "demo", threadCount: 2, openLoopCount: 1, proposalCount: 1, connectionCount: 1, reviewCount: 2, indexDocumentCount: 2, queueDepth: 0, isolatedFromLive: true });
    const threads = await (await threadsRoute.GET(new Request("http://local/threads?dataset=demo&status=all&limit=50"))).json();
    expect(threads.items.map((item: any) => item.title)).toEqual(["Marlowe billing fix", "Marlowe invoice follow-up"]);
  });

  test("demo surfaces include readable evidence and completed archaeology", async () => {
    const loops = await (await openLoopsRoute.GET(new Request("http://local/open-loops?dataset=demo&status=open"))).json();
    expect(loops.items).toHaveLength(1);
    expect(loops.items[0].title).toBe("Verify the production billing fix against Marlowe's next invoice run");
    expect(loops.items[0].sources[0].conversationTitle).toBe("Billing fix verification restart");

    const archaeology = await (await reviewRoute.GET(new Request("http://local/review?dataset=demo&type=archaeology"))).json();
    expect(archaeology.items[0].status).toBe("completed");
    expect(archaeology.items[0].timeline).toHaveLength(4);
  });

  test("demo actions mutate demo only and reset restores it", async () => {
    const live = freshDb(); createThread(live, "Live invariant", null); const before = count(live, "threads");
    const action = await actionRoute.POST(new Request("http://local/action", { method: "POST", body: JSON.stringify({ dataset: "demo", action: "reject_proposal", targetId: DEMO_IDS.callProposal }) }));
    expect(action.status).toBe(202);
    const afterAction = await (await statusRoute.GET(new Request("http://local/status?dataset=demo"))).json();
    expect(afterAction.proposalCount).toBe(0);
    expect(count(live, "threads")).toBe(before);

    const reset = await resetRoute.POST(new Request("http://local/demo-reset", { method: "POST", body: JSON.stringify({ confirm: "RESET_DEMO" }) }));
    expect(reset.status).toBe(200);
    const afterReset = await (await statusRoute.GET(new Request("http://local/status?dataset=demo"))).json();
    expect(afterReset.proposalCount).toBe(1);
    expect(count(live, "threads")).toBe(before);
  });

  test("invalid datasets and unconfirmed reset are rejected", async () => {
    expect((await statusRoute.GET(new Request("http://local/status?dataset=staging"))).status).toBe(400);
    expect((await resetRoute.POST(new Request("http://local/demo-reset", { method: "POST", body: JSON.stringify({}) }))).status).toBe(400);
  });

  test("a live id cannot be used as a demo action target", async () => {
    const response = await actionRoute.POST(new Request("http://local/action", { method: "POST", body: JSON.stringify({ dataset: "demo", action: "mark_done", targetId: "live_object_12345" }) }));
    expect(response.status).toBe(404);
  });
});
