import { normalizeBackfillRequest } from "../src/backfillScope.ts";
import { datasetFromBody, failure } from "../src/routeDataset.ts";

type Core = Record<string, unknown>;
type Body = { dataset?: unknown; action?: string; targetId?: string; reason?: string; query?: string; threadId?: string; maxJobs?: number; mode?: string; backfillMode?: string; scope?: unknown; backfillScope?: unknown; days?: unknown; dayCount?: unknown; startDate?: unknown; endDate?: unknown; confirmAllHistory?: boolean; allowAllHistory?: boolean; confirmReset?: boolean };
async function core(): Promise<Core> { return (await import("../src/index.ts")) as Core; }
function id(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(value); }
export async function POST(request: Request): Promise<Response> {
  let body: Body;
  try { body = await request.json() as Body; } catch { return failure(new Error("request body must be JSON"), "request body must be JSON", 400); }
  try {
    const dataset = datasetFromBody(body.dataset);
    const action = body.action;
    const enqueueActions = new Set(["request_archaeology", "rebuild_index", "start_backfill", "process_queue"]);
    const reviewActions = new Set(["accept_proposal", "reject_proposal", "snooze", "mark_done", "archive_thread", "explore", "save_as_hypothesis", "create_open_loop", "dismiss_connection", "mark_wrong"]);
    if (dataset === "demo" && action === "reset_demo") {
      if (body.confirmReset !== true) return failure(new Error("reset_demo requires confirmation"), "reset_demo requires confirmation", 400);
      return Response.json(await (await import("../src/demo.ts")).resetDemo(true));
    }
    if (dataset === "demo" && typeof action === "string" && action === "archive_thread") {
      return Response.json({ ok: false, error: { code: "UNSUPPORTED_DEMO_ACTION", message: "unsupported demo action: archive_thread" } }, { status: 400 });
    }
    if (typeof action !== "string" || (!enqueueActions.has(action) && !reviewActions.has(action))) return failure(new Error("unsupported action"), "unsupported action", 400);
    if (reviewActions.has(action) && !id(body.targetId)) return failure(new Error("targetId is required"), "targetId is required", 400);
    if (dataset === "demo") {
      if (enqueueActions.has(action)) return failure(new Error(`unsupported demo action: ${action}`), `unsupported demo action: ${action}`, 400);
      try {
        const job = await (await import("../src/demo.ts")).runDemoAction({ ...body, action });
        return Response.json({ ok: true, accepted: true, job }, { status: 202 });
      } catch (error) { return failure(error, "Demo action failed", 400); }
    }
    if (action === "request_archaeology" && (!body.query || body.query.trim().length < 2 || body.query.length > 500)) return failure(new Error("query is required and must be 2-500 characters"), "query is required and must be 2-500 characters", 400);
    if (action === "start_backfill") {
      try { normalizeBackfillRequest({ ...body, mode: body.backfillMode ?? body.mode }); }
      catch (error) { return failure(error, "invalid backfill scope", 400); }
    }
    try {
      const loaded = await core(); const fn = loaded.enqueueAction ?? loaded.enqueueJob ?? loaded.requestAction;
      if (typeof fn !== "function") return failure(new Error("core unavailable"), "Threadkeeper core is not ready");
      const payload = { kind: action, action, targetId: body.targetId, query: body.query?.trim(), reason: body.reason?.slice(0, 500), maxJobs: Math.max(1, Math.min(20, Math.floor(Number(body.maxJobs) || 5))), mode: body.backfillMode ?? body.mode, scope: body.scope ?? body.backfillScope, days: body.days ?? body.dayCount, startDate: body.startDate, endDate: body.endDate, confirmAllHistory: body.confirmAllHistory, allowAllHistory: body.allowAllHistory };
      const job = await (fn as (x: unknown) => unknown)(payload);
      return Response.json({ ok: true, accepted: true, job }, { status: 202 });
    } catch { return failure(new Error("Action could not be queued"), "Action could not be queued"); }
  } catch (error) { return failure(error, "Action could not be queued", 400); }
}
