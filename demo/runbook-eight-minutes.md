# Eight-minute Threadkeeper demo runbook

Use the disposable assistant workspace only. The fixture is synthetic and spans January 8-August 1, 2026.

## 0:00-0:45 — prove the environment is safe and healthy

```bash
cd <path-to-threadkeeper>
assistant status --json
assistant plugins inspect threadkeeper --json
assistant schedules list --json
```

Call out: separate workspace, plugin status `ok`, and the bounded process-queue schedule.

## 0:45-1:30 — reset and seed

```bash
THREADKEEPER_DEMO=1 THREADKEEPER_DEMO_CONFIRM_RESET=1 bun run scripts/demo-reset.ts
THREADKEEPER_DEMO=1 bun run scripts/demo-seed.ts
```

Explain that all six conversations use stable `threadkeeper-demo:` source keys. Re-running seed is safe: the importer skips existing source keys.

## 1:30-2:15 — process twice

```bash
THREADKEEPER_DEMO=1 bun run scripts/demo-process.ts
THREADKEEPER_DEMO=1 bun run scripts/demo-process.ts
```

Show the bounded queue reaching zero. Explain that the second run is the idempotency check: identical messages do not create duplicate visible artifacts.

## 2:15-3:15 — open loops

Open the Threadkeeper dashboard or run the supported tool action `list_open_loops`.

Show:

- **Open:** publish the Northstar landing page, due **August 20, 2026**.
- **Closed:** buy the domain.
- **Closed:** draft issue zero.

Emphasize the distinction: issue-zero drafting and domain purchase are complete, but landing-page publication is not.

## 3:15-4:30 — Context Archaeology

Ask:

> How did the Northstar newsletter evolve, and why did the cadence change?

The report should order evidence chronologically:

1. **January 8:** weekly newsletter and launch tasks.
2. **April 3:** interviews, podcast, and research database expand scope; launch is blocked, not proven abandoned.
3. **June 18:** weekly is corrected to monthly; domain is bought; landing page remains unpublished.
4. **August 1:** Northstar restarts; issue zero is drafted; landing page remains unresolved.

Show separate timeline, known, inferred, unknown, and unresolved sections with source/message provenance.

## 4:30-5:30 — Memory Gardener correction

Open review proposals. Show the reviewable supersession:

> Replace the current weekly-cadence claim with monthly. Preserve weekly as historical context.

Accept the proposal if demonstrating the action flow. Verify that weekly remains historical evidence and monthly is current; no global memory file is silently edited.

## 5:30-6:30 — Serendipity Engine

Show the proposed `reuse` connection:

> The client briefing format could provide Northstar's issue structure.

The explanation should cite both the client-briefing and Northstar/research threads, specifically five developments, why each matters, and one recommended action. Label it a hypothesis/proposal, not a fact or automatic action.

Dismiss it once, reprocess, and show dismissal suppression: the same fingerprint does not return during its cooldown.

## 6:30-7:30 — live stop hook

In a new disposable-workspace conversation, say:

> For Northstar, I finished the landing-page copy. I still need to publish it by August 20, 2026.

End the turn. Show one dirty row, then manually execute the declared schedule. The loop stays open because finished copy is not a published page. Refer to [`live-stop-hook.md`](./live-stop-hook.md) for timing and failure-open checks.

## 7:30-8:00 — deletion and close

Delete the research-notes fixture through the supported conversation deletion path and process once more. Show that its derived records and private index document are removed, repeated cleanup is safe, and stale queued work cannot resurrect it.

Finish with:

```bash
THREADKEEPER_DEMO=1 bun run scripts/demo-verify.ts
THREADKEEPER_DEMO=1 THREADKEEPER_DEMO_CONFIRM_RESET=1 bun run scripts/demo-reset.ts
```

The final reset must be run only after the audience has seen the results and only while the daemon reports the disposable workspace.
