import { failure, readDataset } from "../src/routeDataset.ts";
type Core = Record<string, unknown>;
async function core(): Promise<Core> { return (await import("../src/index.ts")) as Core; }
export async function GET(request: Request = new Request("http://local/status")): Promise<Response> {
  try {
    if (readDataset(new URL(request.url)) === "demo") return Response.json(await (await import("../src/demo.ts")).getDemoStatus());
    const loaded = await core(); const fn = loaded.getStatus ?? loaded.status;
    if (typeof fn !== "function") return failure(new Error("core unavailable"), "Threadkeeper status is temporarily unavailable");
    return Response.json(await (fn as () => unknown)());
  } catch (error) { return failure(error, "Threadkeeper status is temporarily unavailable"); }
}
