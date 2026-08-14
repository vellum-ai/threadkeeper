# Threadkeeper Northstar Demo — Runbook

A deterministic, six-conversation fixture (`fixtures/threadkeeper-demo.json`, Jan–Aug 2026) that
exercises threads, direct and inferred open loops, claim supersession, archaeology, a serendipity
connection, dismissal suppression, and deletion propagation end to end. `expected-results.json` is
the checklist `demo-verify.ts` grades the live output against.

## Safety model — read this before running anything

The demo seeds real conversations into a real running assistant and drives its real inference
provider. It must **never** run against your everyday assistant. Three independent guards enforce
that:

1. **`THREADKEEPER_DEMO=1` is required.** Every demo script (`demo-lib.ts`'s
   `assertDisposableWorkspace`) refuses to run without it — an explicit, unmissable opt-in.
2. **`DEMO_WORKSPACE` must be a known-disposable path.** Defaults to
   `/workspace/data/threadkeeper-demo-workspace`; `/tmp/threadkeeper-demo-workspace` is also
   allowed. Anything else (including bare `/workspace`, `/`, or a path containing
   `/workspace/plugins/threadkeeper`) is rejected outright, even with the env var set, unless you
   also set `THREADKEEPER_DEMO_ALLOW_CUSTOM=1` — a second explicit override for a genuinely
   different disposable location.
3. **`assertDaemonWorkspace()` checks the *live* daemon, not just the env var.** Before seeding,
   processing, verifying, or resetting, every script runs `assistant status --json` and compares
   its reported `workspace` field to `DEMO_WORKSPACE`. If the CLI is talking to your real daemon
   (workspace `/workspace`), every demo script refuses to proceed — misconfiguration fails safe,
   not silently against your real archive.

Because of guard 3, the demo **requires a second assistant daemon instance** whose
`VELLUM_WORKSPACE_DIR` points at the disposable path. The `assistant` CLI always talks to whichever
daemon it can reach; there is no per-command `--workspace` override. Standing up that second
instance is environment-specific (the same supervisor/launch mechanism your primary daemon uses,
started with `VELLUM_WORKSPACE_DIR=/workspace/data/threadkeeper-demo-workspace` and, if your setup
requires it, a distinct IPC socket/port) — this runbook does not automate that step, since it
depends on how your deployment launches the daemon process. If you cannot start a second instance,
run only the daemon-free steps below (`demo:validate`, `bun test`) and use the **live hook
procedure** (`LIVE-HOOK-PROCEDURE.md`) for careful, single-conversation checks against a real
daemon instead of the bulk fixture.

## A confirmed CLI limitation that shapes this design

`assistant tools run <name>` does **not** execute plugin tools — verified against a live daemon
with Threadkeeper actually loaded (status `ok`, no issues): it runs in a separate, lightweight,
standalone process that only knows about core built-in tools and workspace tools, and reports a
registered plugin tool as `Unknown tool`. There is no CLI command that invokes a plugin tool
outside a real conversation turn. Because of this:

- `demo:process` drives real background work through `assistant schedules execute <schedule-id>`
  (the declared `process-queue` schedule), which runs through the real agent loop with the full
  tool catalog — the same mechanism the 15-minute cadence uses, just triggered on demand. If
  `assistant schedules list` doesn't yet show the schedule right after the plugin loads, wait a
  moment and check `assistant plugins inspect threadkeeper` — the schedule needs to materialize
  into the live schedule store before it can be executed this way.
- `demo:verify` reads Threadkeeper's own SQLite file directly (read-only) rather than going through
  the tool or a route — simpler and more reliable than reverse-engineering the gateway's
  authenticated tunnel for a demo script.
- Archaeology specifically requires the model to actually decide to call the tool (or a person to
  ask a real question in a real turn); `demo:verify` checks a completed archaeology job's output if
  one already exists, but does not trigger one itself. See `LIVE-HOOK-PROCEDURE.md`.

## What each script does

| Script | Needs a daemon? | What it does |
| --- | --- | --- |
| `bun run demo:validate` | No | Validates the fixture JSON and its required concepts against `expected-results.json`. Safe to run anytime. |
| `bun run demo:seed` | Yes (disposable) | Imports the six fixture conversations via `assistant conversations import` and resolves their conversation ids into `demo/state.json`. |
| `bun run demo:process` | Yes (disposable) | Marks the seeded conversation ids dirty (imported conversations never fire the `stop` hook, so this replaces it) directly in the plugin's own SQLite file, then triggers the declared `process-queue` schedule (`assistant schedules execute <id>`) in bounded rounds. |
| `bun run demo:verify` | Yes (disposable) | Reads Threadkeeper's own SQLite file directly (read-only) and checks the required concepts from `expected-results.json` against threads, open loops, claim proposals, and connections. Also writes the result into `demo/state.json`. |
| `bun run demo:reset` | Yes (disposable) | Requires `THREADKEEPER_DEMO_CONFIRM_RESET=1` (set automatically by the npm script) and clears the disposable daemon's conversations via `assistant conversations clear` — safe *only* because `assertDaemonWorkspace` already confirmed you're not pointed at a real archive. |
| `bun run demo:all` | Yes (disposable) | Reset → seed → process (twice, to check idempotency) → verify, in one shot. |

## Procedure

1. Stand up a disposable assistant daemon with `VELLUM_WORKSPACE_DIR=/workspace/data/threadkeeper-demo-workspace` (or `/tmp/threadkeeper-demo-workspace`).
2. Install (or symlink) this plugin into `<disposable-workspace>/plugins/threadkeeper/`.
3. Confirm it loaded: `assistant plugins list` / `assistant plugins inspect threadkeeper` against the disposable daemon should report `ok`.
4. Confirm a configured inference provider exists on that instance — extraction and archaeology need one; without it, `demo:process` will leave conversations retryable with `NO_PROVIDER` and `demo:verify` will fail its content checks (not a bug, just no evidence to check).
5. From this plugin directory:
   ```bash
   bun run demo:validate
   bun run demo:seed
   bun run demo:process
   bun run demo:verify
   ```
   Or `bun run demo:all` to do reset → seed → process ×2 → verify in sequence (the double process run is the idempotency check: identical input the second time must not create new visible proposals or connections).
6. Inspect `demo/state.json` for the full seed/process/verify trail, and the disposable workspace's Threadkeeper app (`plugins~threadkeeper~threadkeeper`) for the dashboard view.
7. For the deletion-propagation checklist item (`expected-results.json`'s `deletion` block, keyed on the `research-notes` conversation), delete that one conversation through the app or a host-level action, then re-run `bun run demo:verify` and confirm its derived thread membership, evidence, and private index document are gone. There is no CLI command for deleting a single conversation, so this step is manual by design — see `LIVE-HOOK-PROCEDURE.md`.
8. `bun run demo:reset` when done, or just discard the disposable workspace entirely.

## What "green" means

`demo:verify` exits non-zero and prints which named checks failed. Because extraction and
archaeology depend on the disposable daemon's actual configured model, exact wording will vary
model to model — the checks grep for required *concepts* (Northstar, client briefing, weekly,
monthly, the landing-page due date, the five-developments briefing structure, and so on), not exact
strings. A failure is worth investigating either way: it means the pipeline didn't surface a
concept the fixture is designed to produce.

## Cleanup

`bun run demo:reset` clears the disposable daemon's conversations and `demo/state.json`. It never
touches anything outside the disposable workspace — `assertDaemonWorkspace` guarantees that. If you
stood up a dedicated daemon process for the demo, tear it down and delete the disposable workspace
directory afterward.
