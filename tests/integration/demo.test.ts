import "../fixtures/plugin-api-mock.ts";
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetDbForTests, getDb } from "../../src/db.ts";
import { resetDemoDbForTests } from "../../src/demoDb.ts";
import { DEMO_IDS, DEMO_SEED_VERSION, DEMO_SEED_VERSION_KEY, ensureDemoSeeded } from "../../src/demoSeed.ts";
import { getDemoStatus, listDemoOpenLoops, listDemoReviews, listDemoThreads, resetDemo, runDemoAction } from "../../src/demo.ts";
import * as statusRoute from "../../routes/status.ts";
import * as openLoopsRoute from "../../routes/open-loops.ts";
import * as reviewRoute from "../../routes/review.ts";
import * as actionRoute from "../../routes/action.ts";

function path(name: string): string { return join(mkdtempSync(join(tmpdir(), "threadkeeper-demo-test-")), name); }
function count(db: any, table: string): number { return (db.query(`SELECT COUNT(*) as n FROM ${table}`).get() as { n: number }).n; }

describe("separate Threadkeeper demo dataset", () => {
  beforeEach(() => {
    resetDbForTests(path("live.sqlite"));
    resetDemoDbForTests(path("threadkeeper-demo.sqlite"));
  });

  test("demo status has the deterministic Operator Week counts", async () => {
    const status = await getDemoStatus();
    expect(status.dataset).toBe("demo");
    expect(status.threadCount).toBe(2);
    expect(status.openLoopCount).toBe(1);
    expect(status.proposalCount).toBe(1);
    expect(status.connectionCount).toBe(1);
    expect(status.reviewCount).toBe(2);
    expect(status.queueDepth).toBe(0);
    expect(status.indexDocumentCount).toBe(2);
    expect(status.lastErrorCode).toBeNull();
  });

  test("a stale seed version upgrades the isolated demo even when the Operator Week thread exists", async () => {
    const demo = resetDemoDbForTests(path("stale-seed.sqlite"));
    ensureDemoSeeded(demo);
    demo.query(`UPDATE schema_meta SET value = 'product-launch-v1' WHERE key = ?`).run(DEMO_SEED_VERSION_KEY);
    demo.query(`UPDATE threads SET title = 'Stale story' WHERE id = ?`).run(DEMO_IDS.billing);

    ensureDemoSeeded(demo);

    expect((demo.query(`SELECT value FROM schema_meta WHERE key = ?`).get(DEMO_SEED_VERSION_KEY) as { value: string }).value).toBe(DEMO_SEED_VERSION);
    expect((demo.query(`SELECT title FROM threads WHERE id = ?`).get(DEMO_IDS.billing) as { title: string }).title).toBe("Marlowe billing fix");
    expect(count(demo, "threads")).toBe(2);
  });

  test("demo routes expose evidence and completed archaeology", async () => {
    const loops = await listDemoOpenLoops({ status: "open", limit: 50 });
    expect(loops.items).toHaveLength(1);
    expect(loops.items[0].id).toBe(DEMO_IDS.verifyLoop);
    expect(loops.items[0].dueAt).toBe(Date.parse("2026-08-20T00:00:00Z"));
    expect(loops.items[0].sources[0].excerpt).toContain("next invoice run is still unverified");

    const archaeology = await listDemoReviews({ type: "archaeology", limit: 20 });
    expect(archaeology.items).toHaveLength(1);
    expect(archaeology.items[0].status).toBe("completed");
    expect(archaeology.items[0].timeline).toHaveLength(4);

    const response = await reviewRoute.GET(new Request("http://local/review?dataset=demo&type=archaeology"));
    expect(response.status).toBe(200);
    expect((await response.json()).items[0].title).toBe("Marlowe billing fix");
  });

  test("live defaults remain live and invalid datasets are rejected", async () => {
    const live = getDb();
    live.query(`INSERT INTO threads(id, title, normalized_title, summary, status, created_at, updated_at) VALUES ('live-thread-1', 'Live only', 'live only', 'fixture', 'active', 1, 1)`).run();
    const defaultResponse = await statusRoute.GET();
    expect(defaultResponse.status).toBe(200);
    expect((await defaultResponse.json()).threadCount).toBe(1);
    const invalid = await openLoopsRoute.GET(new Request("http://local/open-loops?dataset=staging"));
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).error.code).toBe("ROUTE_VALIDATION_FAILED");
  });

  test("demo actions mutate only demo, and reset restores the seed", async () => {
    const live = getDb();
    live.query(`INSERT INTO threads(id, title, normalized_title, summary, status, created_at, updated_at) VALUES ('live-thread-2', 'Live fixture', 'live fixture', 'must remain', 'active', 1, 1)`).run();
    const before = { threads: count(live, "threads"), proposals: count(live, "proposals"), connections: count(live, "connections") };
    runDemoAction({ action: "reject_proposal", targetId: DEMO_IDS.callProposal, reason: "test" });
    expect((await listDemoReviews({ type: "proposal", limit: 20 })).items).toHaveLength(0);
    expect(count(live, "threads")).toBe(before.threads);
    expect(count(live, "proposals")).toBe(before.proposals);
    expect(count(live, "connections")).toBe(before.connections);

    const resetResponse = await actionRoute.POST(new Request("http://local/action", { method: "POST", body: JSON.stringify({ dataset: "demo", action: "reset_demo", confirmReset: true }) }));
    expect(resetResponse.status).toBe(200);
    expect((await getDemoStatus()).proposalCount).toBe(1);
    expect((await getDemoStatus()).connectionCount).toBe(1);
    expect(count(live, "threads")).toBe(before.threads);
    expect(count(live, "proposals")).toBe(before.proposals);
    expect(count(live, "connections")).toBe(before.connections);
    resetDemo(true);
  });

  test("accepting the call reschedule makes Thursday current, preserves Wednesday history, and is idempotent", async () => {
    const demo = resetDemoDbForTests(path("call.sqlite"));
    await getDemoStatus();
    const before = demo.query(`SELECT id, object_json, status FROM claims WHERE subject='Marlowe billing review call' AND predicate='call time'`).all() as Array<{ id: string; object_json: string; status: string }>;
    expect(before).toHaveLength(1);
    expect(JSON.parse(before[0]!.object_json)).toBe("Wednesday 2:00 PM");
    expect(before[0]!.status).toBe("active");

    const accepted = await runDemoAction({ action: "accept_proposal", targetId: DEMO_IDS.callProposal });
    expect(accepted.result).toMatchObject({ supersededClaimId: DEMO_IDS.callClaim });
    expect(accepted.result.createdClaimId).toBeTruthy();
    expect("updatedClaimId" in accepted.result).toBe(false);

    const claims = demo.query(`SELECT id, object_json, status, supersedes_claim_id FROM claims WHERE subject='Marlowe billing review call' AND predicate='call time' ORDER BY created_at`).all() as Array<{ id: string; object_json: string; status: string; supersedes_claim_id: string | null }>;
    expect(claims).toHaveLength(2);
    expect(claims.map((claim) => [JSON.parse(claim.object_json), claim.status])).toEqual([["Wednesday 2:00 PM", "superseded"], ["Thursday 10:00 AM", "active"]]);
    expect(claims[1]!.supersedes_claim_id).toBe(DEMO_IDS.callClaim);
    const threads = await listDemoThreads({ status: "all", limit: 20 });
    expect(threads.items.find((item: any) => item.id === DEMO_IDS.billing)?.cadence).toEqual({ current: "Thursday 10:00 AM", history: ["Wednesday 2:00 PM"] });

    const repeated = await runDemoAction({ action: "accept_proposal", targetId: DEMO_IDS.callProposal });
    expect(repeated.result).toMatchObject({ alreadyReviewed: true, status: "accepted" });
    expect(count(demo, "claims")).toBe(2);

    await resetDemo(true);
    const restored = demo.query(`SELECT object_json, status FROM claims WHERE subject='Marlowe billing review call' AND predicate='call time'`).all() as Array<{ object_json: string; status: string }>;
    expect(restored).toHaveLength(1);
    expect([JSON.parse(restored[0]!.object_json), restored[0]!.status]).toEqual(["Wednesday 2:00 PM", "active"]);
    expect((await getDemoStatus()).proposalCount).toBe(1);
  });

  test("demo action endpoint rejects unsupported actions without falling through", async () => {
    const response = await actionRoute.POST(new Request("http://local/action", { method: "POST", body: JSON.stringify({ dataset: "demo", action: "archive_thread", targetId: DEMO_IDS.billing }) }));
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("UNSUPPORTED_DEMO_ACTION");
    expect((await listDemoThreads({ status: "all", limit: 20 })).items).toHaveLength(2);
  });
});
