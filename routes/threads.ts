import { failure, readDataset } from "../src/routeDataset.ts";
type Core = Record<string, unknown>;
async function core(): Promise<Core> { return (await import("../src/index.ts")) as Core; }
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url); const status = url.searchParams.get("status") ?? "active"; const n = Number(url.searchParams.get("limit")); const limit = Number.isFinite(n) ? Math.max(1, Math.min(50, Math.floor(n))) : 50;
  if (!["active", "blocked", "done", "archived", "dormant", "all"].includes(status)) return failure(new Error("invalid thread status"), "invalid thread status", 400);
  try {
    if (readDataset(url) === "demo") return Response.json(await (await import("../src/demo.ts")).listDemoThreads({ status, limit }));
    const loaded = await core(); const fn = loaded.listThreads; if (typeof fn !== "function") throw new Error("core unavailable");
    return Response.json(await (fn as (x: unknown) => unknown)({ status, limit }));
  } catch (error) { return failure(error, "Threads are temporarily unavailable"); }
}
