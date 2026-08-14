import { failure, readDataset } from "../src/routeDataset.ts";
type Core = Record<string, unknown>;
async function core(): Promise<Core> { return (await import("../src/index.ts")) as Core; }
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url); const id = url.searchParams.get("id"); if (!id || !/^[A-Za-z0-9_-]{8,128}$/.test(id)) return failure(new Error("id is required"), "id is required", 400);
  try {
    if (readDataset(url) === "demo") return Response.json(await (await import("../src/demo.ts")).getDemoThread({ id }));
    const loaded = await core(); const fn = loaded.getThread; if (typeof fn !== "function") throw new Error("core unavailable"); return Response.json(await (fn as (x: unknown) => unknown)({ id }));
  } catch (error) { return failure(error, "Thread is temporarily unavailable"); }
}
