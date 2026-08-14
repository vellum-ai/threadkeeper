import { assertDaemonWorkspace, assertDisposableWorkspace, loadState, resetLocalDemoState, runCli } from "./demo-lib.ts";

assertDisposableWorkspace();
await assertDaemonWorkspace();
if (process.env.THREADKEEPER_DEMO_CONFIRM_RESET !== "1") throw new Error("Set THREADKEEPER_DEMO_CONFIRM_RESET=1 to clear the disposable demo conversation archive.");
const state = await loadState();
if (!state) { await resetLocalDemoState(); console.log(JSON.stringify({ ok: true, cleared: false, reason: "no local demo state" })); process.exit(0); }
const result = await runCli(["conversations", "clear", "--json"], { allowFailure: true });
if (result.code !== 0) throw new Error(`Disposable reset failed: ${result.stderr || result.stdout}`);
await resetLocalDemoState();
console.log(JSON.stringify({ ok: true, cleared: true, result: result.stdout.trim() }, null, 2));
