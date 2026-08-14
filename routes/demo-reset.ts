import { failure } from "../src/routeDataset.ts";
export async function POST(request: Request): Promise<Response> {
  try {
    const body = await request.json() as { confirm?: unknown };
    if (body.confirm !== true && body.confirm !== "RESET_DEMO") return failure(new Error("demo reset requires confirmation"), "demo reset requires confirmation", 400);
    return Response.json(await (await import("../src/demo.ts")).resetDemo(body.confirm));
  } catch (error) { return failure(error, "Demo reset failed"); }
}
