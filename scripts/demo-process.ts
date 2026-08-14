/**
 * `demo-seed.ts` imports conversations via `assistant conversations import`, which is a data
 * shortcut — it never runs a live agent turn, so the `stop` hook never fires and nothing lands in
 * `dirty_conversations` automatically. Before draining, this script marks exactly the six demo
 * conversation ids dirty by writing directly to the disposable daemon's own Threadkeeper SQLite
 * file (the same row shape `markDirty` writes) — never anything outside those ids.
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import {
  assertDaemonWorkspace,
  assertDisposableWorkspace,
  DEMO_DB_PATH,
  loadState,
  resolveProcessQueueScheduleId,
  runCli,
  writeJson,
  STATE_PATH,
} from "./demo-lib.ts";

assertDisposableWorkspace();
await assertDaemonWorkspace();
const state = await loadState();
if (!state) throw new Error("No demo state found. Run THREADKEEPER_DEMO=1 bun run scripts/demo-seed.ts first.");
const scheduleId = await resolveProcessQueueScheduleId();

const conversationIds = Object.values(state.conversationIds);
if (conversationIds.length === 0) {
  throw new Error("Demo state has no resolved conversation ids. Re-run demo-seed and confirm `assistant conversations list` exposes a title match for each fixture conversation.");
}
if (!existsSync(DEMO_DB_PATH)) {
  throw new Error(`Threadkeeper database not found at ${DEMO_DB_PATH}. Install/load the plugin in the disposable workspace (assistant plugins list) before running demo:process.`);
}

function markDirty(ids: string[]): void {
  const db = new Database(DEMO_DB_PATH);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const now = Date.now();
    const upsert = db.query(
      `INSERT INTO dirty_conversations(conversation_id, touched_at, request_id) VALUES (?, ?, NULL)
       ON CONFLICT(conversation_id) DO UPDATE SET touched_at = excluded.touched_at`,
    );
    for (const id of ids) upsert.run(id, now);
  } finally {
    db.close();
  }
}

function dirtyCount(ids: string[]): number {
  const db = new Database(DEMO_DB_PATH, { readonly: true });
  try {
    const placeholders = ids.map(() => "?").join(",");
    const row = db.query(`SELECT COUNT(*) as n FROM dirty_conversations WHERE conversation_id IN (${placeholders})`).get(...ids) as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

markDirty(conversationIds);

// `assistant tools run <plugin-tool>` does not execute plugin tools (confirmed against a live
// daemon — only core built-ins and workspace tools run there). Driving real background processing
// from outside a conversation turn goes through the declared schedule instead, which runs through
// the real agent loop with the full tool catalog available.
const runs: unknown[] = [];
for (let attempt = 1; attempt <= 8; attempt++) {
  if (dirtyCount(conversationIds) === 0) break;
  const result = await runCli(["schedules", "execute", scheduleId], { allowFailure: true });
  runs.push({ attempt, code: result.code, stdout: result.stdout.trim(), stderr: result.stderr.trim() });
  // schedules execute runs asynchronously; give the turn a moment to actually process before re-checking.
  await Bun.sleep(3000);
}

const remaining = dirtyCount(conversationIds);
await writeJson(STATE_PATH, { ...state, processingRuns: runs });
console.log(JSON.stringify({ ok: remaining === 0, attempts: runs.length, remainingDirty: remaining, runs }, null, 2));
if (remaining > 0) {
  console.error(`Warning: ${remaining} demo conversation(s) still dirty after ${runs.length} rounds.`);
  process.exitCode = 1;
}
