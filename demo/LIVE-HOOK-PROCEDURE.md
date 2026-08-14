# Live Hook Verification Procedure

The Operator Week fixture (`demo:seed`) imports conversations via `assistant conversations import`,
which writes rows directly into the conversation store — it never runs the agent loop, so the
`stop` hook never fires for those rows. `demo:process` compensates by marking them dirty directly.
That means the bulk demo never actually exercises the live capture path end to end.

This procedure does — a small, manual, low-risk check that the `stop` hook really fires during a
real turn and really queues work, run against the **same disposable daemon** the rest of the demo
uses (never against a real archive; see `RUNBOOK.md`'s safety model first).

## What this proves that the bulk demo doesn't

- The `stop` hook is actually wired into the running assistant's agent loop (not just present on disk).
- It completes fast enough not to be noticeable (target: p95 under 20ms — `tests/performance/perf.test.ts` checks this in isolation; this procedure checks it's true for a real turn, not just a synthetic call).
- A real turn produces exactly one `dirty_conversations` row, which the schedule (or a manual `process_queue`) then drains into real threads/loops/proposals.
- The declared schedule (`schedules/process-queue/`) is actually registered and attributable to Threadkeeper.

## Procedure

1. Confirm you're on the disposable daemon (`assistant status --json` reports the disposable workspace — same guard the scripts use).
2. Start a fresh conversation and send one real message that should produce a direct open loop, e.g.:
   ```bash
   assistant conversations new "Threadkeeper live hook check"
   ```
   Then send a message through your normal client (or `assistant conversations wake <id>` with an appropriate hint, if your setup supports driving a turn headlessly) containing something like: *"I need to confirm the Marlowe billing fix in production before Thursday's call."* Let the turn complete normally.
3. Immediately after the turn ends, inspect the plugin's dirty queue directly (bounded, read-only):
   ```bash
   assistant bash "sqlite3 <disposable-workspace>/plugins/threadkeeper/data/threadkeeper.sqlite \"SELECT conversation_id, touched_at FROM dirty_conversations\""
   ```
   (Requires `VELLUM_DEBUG=1` on that daemon; only use this against the disposable instance.) You should see exactly one row for the new conversation, with `touched_at` close to the current time.
4. Confirm the schedule is registered and attributed to Threadkeeper:
   ```bash
   assistant schedules list
   ```
   Find `process-queue` under the `threadkeeper` plugin.
5. Trigger it manually rather than waiting 15 minutes:
   ```bash
   assistant schedules execute <schedule-id>
   ```
6. Confirm the dirty row is gone and a thread/open-loop now exists. `assistant tools run
   threadkeeper` does not work here either (see `RUNBOOK.md`) — read the table directly instead:
   ```bash
   assistant bash "sqlite3 <disposable-workspace>/plugins/threadkeeper/data/threadkeeper.sqlite \"SELECT description, status, origin_type, due_at FROM open_loops ORDER BY created_at DESC LIMIT 5\""
   ```
   The billing-verification loop should be present, with `origin_type = direct` and a due date. To see its
   provenance, join through `created_from_artifact_id` → `evidence_edges` → `source_revisions` →
   `sources` and confirm the `message_id` matches the message you just sent, not a fixture message.
7. Send a follow-up in the same conversation confirming completion (e.g. *"Done, renewed it."*),
   trigger the schedule again, and confirm the loop closes.

## What to do if a step fails

- **No dirty row after the turn** — the `stop` hook isn't firing. Check `assistant plugins inspect threadkeeper` for load errors first; a plugin that failed to load contributes no hooks at all.
- **Dirty row never clears after triggering the schedule** — check `assistant schedules runs <schedule-id>` for the run's status and error, and confirm a model provider is configured (`NO_PROVIDER` is the most common cause; the row stays retryable, which is correct fail-open behavior, but nothing will visibly complete until a provider is configured).
- **Hook latency concerns** — this procedure is a spot check, not a benchmark; trust `tests/performance/perf.test.ts` for the actual p95 measurement, which runs against a warm database with no host-machine variance.

This procedure never touches conversation content outside what you type yourself, and — like every
other demo script — depends entirely on being pointed at the disposable daemon. If `assistant
status --json` reports your real workspace, stop and fix your daemon target before continuing.
