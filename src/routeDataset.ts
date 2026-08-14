export type Dataset = "live" | "demo";

export function readDataset(url: URL): Dataset {
  const value = url.searchParams.get("dataset") ?? "live";
  if (value !== "live" && value !== "demo") throw new Error("invalid dataset; expected live or demo");
  return value;
}

export function datasetFromBody(value: unknown): Dataset {
  const dataset = value ?? "live";
  if (dataset !== "live" && dataset !== "demo") throw new Error("invalid dataset; expected live or demo");
  return dataset;
}

export function failure(error: unknown, fallback: string, unavailableStatus = 503): Response {
  const message = error instanceof Error ? error.message : fallback;
  const unsupportedDemo = message.includes("unsupported demo action");
  const validation = /invalid|required|unsupported|must be JSON|confirmation/i.test(message);
  const notFound = message.includes("not found");
  const code = unsupportedDemo ? "UNSUPPORTED_DEMO_ACTION" : validation ? "ROUTE_VALIDATION_FAILED" : notFound ? "NOT_FOUND" : "DB_UNAVAILABLE";
  return Response.json({ ok: false, error: { code, message: validation || notFound ? message : fallback } }, { status: validation ? 400 : notFound ? 404 : unavailableStatus });
}
