import { failure, readDataset } from "../src/routeDataset.ts";
type Core = Record<string, unknown>;
async function core(): Promise<Core> { return (await import("../src/index.ts")) as Core; }
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url); const type = url.searchParams.get("type") ?? "all"; const n = Number(url.searchParams.get("limit")); const limit = Number.isFinite(n) ? Math.max(1, Math.min(50, Math.floor(n))) : 50;
  if (!["proposal", "connection", "archaeology", "all"].includes(type)) return failure(new Error("invalid review type"), "invalid review type", 400);
  try {
    if (readDataset(url) === "demo") return Response.json(await (await import("../src/demo.ts")).listDemoReviews({ type, limit }));
    const loaded = await core(); const fn = loaded.listReviews; if (typeof fn !== "function") throw new Error("core unavailable");
    return Response.json(await (fn as (x: unknown) => unknown)({ type, limit }));
  } catch (error) { return failure(error, "Review items are temporarily unavailable"); }
}
