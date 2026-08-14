import { join, dirname } from "node:path";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";

export const PLUGIN_DIR = dirname(import.meta.dir);
export const DEMO_DIR = join(PLUGIN_DIR, "demo");
export const FIXTURE_PATH = join(DEMO_DIR, "fixtures", "threadkeeper-demo.json");
export const EXPECTED_PATH = join(DEMO_DIR, "expected-results.json");
export const STATE_PATH = join(DEMO_DIR, "state.json");
export const DEMO_WORKSPACE = process.env.THREADKEEPER_DEMO_WORKSPACE || "/workspace/data/threadkeeper-demo-workspace";

/**
 * Path to the plugin's own SQLite file *inside the disposable demo workspace* — not this source
 * checkout's `PLUGIN_DIR`. The demo runs against a separate assistant daemon bound to
 * `DEMO_WORKSPACE` (see `assertDaemonWorkspace`), which has its own `plugins/threadkeeper/data/`
 * install, entirely distinct from the real workspace's plugin data.
 */
export const DEMO_DB_PATH = join(DEMO_WORKSPACE, "plugins", "threadkeeper", "data", "threadkeeper.sqlite");

export type DemoFixture = {
  datasetId: string;
  conversations: Array<{
    sourceKey: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    messages: Array<{ role: "user" | "assistant"; content: string; createdAt: number }>;
  }>;
};

export type DemoState = {
  datasetId: string;
  fixturePath: string;
  workspace: string;
  sourceKeys: string[];
  conversationIds: Record<string, string>;
  importedAt: string;
  importResult?: unknown;
  processingRuns?: unknown[];
  verification?: unknown;
  deletionCheck?: { sourceKey: string; verified: boolean; checkedAt: string; notes?: string };
};

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}
export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
export async function loadFixture(): Promise<DemoFixture> {
  const fixture = await readJson<DemoFixture>(FIXTURE_PATH);
  assertFixture(fixture);
  return fixture;
}
export async function loadExpected(): Promise<Record<string, unknown>> { return readJson(EXPECTED_PATH); }
export async function loadState(): Promise<DemoState | null> { try { return await readJson<DemoState>(STATE_PATH); } catch { return null; } }

export function assertFixture(fixture: DemoFixture): void {
  if (!fixture.datasetId || !Array.isArray(fixture.conversations) || fixture.conversations.length !== 6) throw new Error("Operator Week fixture must contain exactly six conversations and a datasetId");
  const keys = fixture.conversations.map((conversation) => conversation.sourceKey);
  if (new Set(keys).size !== keys.length || keys.some((key) => !key.startsWith("threadkeeper-demo:"))) throw new Error("Every fixture conversation needs a unique threadkeeper-demo: sourceKey");
  const dates = fixture.conversations.map((conversation) => conversation.createdAt);
  if (dates.some((date, index) => index > 0 && date < dates[index - 1])) throw new Error("Fixture conversations must be chronologically ordered");
  for (const conversation of fixture.conversations) {
    if (!conversation.title || !conversation.messages.length) throw new Error(`Invalid fixture: ${conversation.sourceKey}`);
    for (const message of conversation.messages) if (!message.content || !Number.isFinite(message.createdAt)) throw new Error(`Invalid message in ${conversation.sourceKey}`);
  }
}

export function assertDisposableWorkspace(): void {
  if (process.env.THREADKEEPER_DEMO !== "1") throw new Error("Set THREADKEEPER_DEMO=1 to run the demo harness");
  const workspace = DEMO_WORKSPACE.replaceAll("\\", "/");
  const allowed = ["/workspace/data/threadkeeper-demo-workspace", "/tmp/threadkeeper-demo-workspace"];
  if (!allowed.includes(workspace) && process.env.THREADKEEPER_DEMO_ALLOW_CUSTOM !== "1") throw new Error(`Refusing demo operation outside a disposable workspace: ${DEMO_WORKSPACE}`);
  if (workspace === "/workspace" || workspace === "/" || workspace.includes("/workspace/plugins/threadkeeper")) throw new Error(`Refusing demo operation against production/plugin workspace: ${DEMO_WORKSPACE}`);
}

export async function assertDaemonWorkspace(): Promise<void> {
  const result = await runCli(["status", "--json"]);
  const status = parseJsonOutput(result.stdout) as { workspace?: string };
  if (status?.workspace !== DEMO_WORKSPACE) throw new Error(`Assistant daemon workspace is ${status?.workspace ?? "unknown"}, expected disposable ${DEMO_WORKSPACE}. Start a separate daemon before seeding.`);
}
export async function resetLocalDemoState(): Promise<void> { await rm(STATE_PATH, { force: true }); }

export async function runCli(args: string[], options: { allowFailure?: boolean } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["assistant", ...args], { stdout: "pipe", stderr: "pipe", env: process.env });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  if (code !== 0 && !options.allowFailure) throw new Error(`assistant ${args.join(" ")} failed (${code}): ${stderr || stdout}`);
  return { code, stdout, stderr };
}
export function parseJsonOutput(raw: string): unknown {
  const trimmed = raw.trim(); if (!trimmed) return null;
  try { return JSON.parse(trimmed); } catch {
    const line = trimmed.split("\n").reverse().find((candidate) => candidate.trim().startsWith("{") || candidate.trim().startsWith("["));
    if (line) try { return JSON.parse(line); } catch { /* table output */ }
    return { raw: trimmed };
  }
}
export function asArray(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
export function flattenText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(flattenText).join(" ");
  if (value && typeof value === "object") return Object.values(value as Record<string, unknown>).map(flattenText).join(" ");
  return "";
}
/**
 * Find the live schedule id for Threadkeeper's declared `process-queue` schedule.
 *
 * `assistant tools run <plugin-tool>` does not execute plugin tools — it only runs core built-ins
 * and workspace tools in a lightweight standalone process (confirmed against a live daemon: a
 * registered plugin tool is reported "Unknown tool"). Triggering real background processing from
 * outside a live conversation turn therefore goes through the declared schedule instead
 * (`assistant schedules execute <id>`), which runs through the real agent loop with the full tool
 * catalog. Plugin-declared schedules may take a moment to materialize into the live schedule store
 * after the plugin loads; this throws a clear, actionable error if it hasn't yet rather than
 * silently doing nothing.
 */
export async function resolveProcessQueueScheduleId(): Promise<string> {
  const result = await runCli(["schedules", "list", "--json"]);
  const parsed = parseJsonOutput(result.stdout) as { schedules?: Array<Record<string, unknown>> };
  const rows = Array.isArray(parsed?.schedules) ? parsed.schedules : [];
  const match = rows.find(
    (row) => row.name === "process-queue" || (typeof row.description === "string" && row.description.includes("Threadkeeper")),
  );
  if (!match || typeof match.id !== "string") {
    throw new Error(
      "Threadkeeper's process-queue schedule was not found in `assistant schedules list`. " +
        "It may not have materialized yet after plugin load — check `assistant plugins inspect threadkeeper` " +
        "reports the schedule under surfaces.schedules, then retry (a daemon restart may be required).",
    );
  }
  return match.id;
}

export function findRows(value: unknown): any[] {
  if (Array.isArray(value)) return value as any[];
  if (value && typeof value === "object") {
    for (const key of ["items", "rows", "threads", "loops", "reviews", "connections", "proposals", "results", "data"]) {
      const nested = (value as any)[key]; if (Array.isArray(nested)) return nested;
    }
  }
  return [];
}
