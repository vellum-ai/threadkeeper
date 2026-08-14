import { failure, readDataset } from "../src/routeDataset.ts";
type Core = Record<string, unknown>;
async function core(): Promise<Core> { return (await import("../src/index.ts")) as Core; }
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url); const status = url.searchParams.get("status") ?? "open"; const n = Number(url.searchParams.get("limit")); const limit = Number.isFinite(n) ? Math.max(1, Math.min(50, Math.floor(n))) : 50;
  if (!["open", "blocked", "done", "dismissed", "all"].includes(status)) return failure(new Error("invalid open-loop status"), "invalid open-loop status", 400);
  try {
    if (readDataset(url) === "demo") return Response.json(await (await import("../src/demo.ts")).listDemoOpenLoops({ status, limit }));
    const loaded = await core(); const fn = loaded.listOpenLoops; if (typeof fn !== "function") throw new Error("core unavailable");
    return Response.json(await (fn as (x: unknown) => unknown)({ status, limit }));
  } catch (error) { return failure(error, "Open loops are temporarily unavailable"); }
}
