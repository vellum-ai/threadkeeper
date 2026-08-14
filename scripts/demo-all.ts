import { assertDaemonWorkspace, assertDisposableWorkspace, runCli } from "./demo-lib.ts";

assertDisposableWorkspace();
await assertDaemonWorkspace();
const env = { ...process.env, THREADKEEPER_DEMO: "1" };
async function run(script: string, extra: Record<string, string> = {}) {
  const proc = Bun.spawn(["bun", "run", `${import.meta.dir}/${script}`], { stdout: "inherit", stderr: "inherit", env: { ...env, ...extra } });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${script} failed with exit code ${code}`);
}
await run("demo-reset.ts", { THREADKEEPER_DEMO_CONFIRM_RESET: "1" });
await run("demo-seed.ts");
await run("demo-process.ts");
await run("demo-process.ts");
await run("demo-verify.ts");
console.log(JSON.stringify({ ok: true, message: "Northstar demo reset, seeded, processed twice, and verified." }, null, 2));
