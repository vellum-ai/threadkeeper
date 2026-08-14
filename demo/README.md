# Threadkeeper Operator Week demo

This is a deterministic, synthetic six-conversation demo spanning **January 8 through August 1, 2026**. It is intentionally separate from the user's real archive.

## Safety contract

The harness refuses to run unless:

- `THREADKEEPER_DEMO=1` is set;
- the assistant daemon reports `workspace` exactly equal to `<workspace>/data/threadkeeper-demo-workspace` (or an explicitly opted-in custom disposable path);
- reset additionally has `THREADKEEPER_DEMO_CONFIRM_RESET=1`.

Setting an environment variable on a single CLI command does **not** move an already-running daemon. Start a second assistant process/daemon configured for the disposable workspace before running the harness. Never point this harness at your everyday assistant workspace.

Default workspace:

```text
/workspace/data/threadkeeper-demo-workspace
```

## Fixture and acceptance files

- `fixtures/threadkeeper-demo.json` — six conversations with stable `threadkeeper-demo:` source keys.
- `expected-results.json` — semantic acceptance criteria, not exact model prose.
- `state.json` — generated IDs and run results; ignored by Git.
- `../scripts/demo-validate.ts` — offline JSON and concept validator.

## Commands

From the Threadkeeper repository root:

```bash
bun run scripts/demo-validate.ts
THREADKEEPER_DEMO=1 bun run scripts/demo-seed.ts
THREADKEEPER_DEMO=1 bun run scripts/demo-process.ts
THREADKEEPER_DEMO=1 bun run scripts/demo-verify.ts
THREADKEEPER_DEMO=1 THREADKEEPER_DEMO_CONFIRM_RESET=1 bun run scripts/demo-reset.ts
THREADKEEPER_DEMO=1 THREADKEEPER_DEMO_CONFIRM_RESET=1 bun run scripts/demo-all.ts
bun test test/demo/fixture.test.ts
```

`demo-seed` uses the official conversation importer. Re-importing the same source keys must report skips rather than new conversations. Imported conversations do not exercise the live stop hook, so the seeder records IDs and the processor explicitly drains only the imported dataset through the plugin queue.

`demo-process` calls the bounded `threadkeeper` `process_queue` action twice in the normal demo flow. `demo-verify` checks the resulting status, loops, reviews, search, and archaeology response for the Marlowe billing fix, invoice follow-up, the Wednesday-to-Thursday call-time correction, closed staging-ship and fix-summary loops, open production-verification due August 20, 2026, chronology, the invoice-to-billing bridge proposal, and provenance-oriented output.

The full live stop-hook procedure is in [`live-stop-hook.md`](./live-stop-hook.md). The eight-minute presentation runbook is in [`runbook-eight-minutes.md`](./runbook-eight-minutes.md).

## Parent integration note

Do not edit the plugin's `package.json` in this slice. Parent integration should add these scripts (or equivalent paths) to the plugin package:

```json
{
  "scripts": {
    "demo:validate": "bun run scripts/demo-validate.ts",
    "demo:seed": "THREADKEEPER_DEMO=1 bun run scripts/demo-seed.ts",
    "demo:process": "THREADKEEPER_DEMO=1 bun run scripts/demo-process.ts",
    "demo:verify": "THREADKEEPER_DEMO=1 bun run scripts/demo-verify.ts",
    "demo:reset": "THREADKEEPER_DEMO=1 THREADKEEPER_DEMO_CONFIRM_RESET=1 bun run scripts/demo-reset.ts",
    "demo:all": "THREADKEEPER_DEMO=1 THREADKEEPER_DEMO_CONFIRM_RESET=1 bun run scripts/demo-all.ts"
  }
}
```

If the package scripts are run from another working directory, change into the Threadkeeper repository root first. The harness itself resolves fixture paths relative to its script location.
