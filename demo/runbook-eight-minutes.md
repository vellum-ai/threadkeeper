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

- **Open:** verify the production billing fix against Marlowe's next invoice run, due **August 20, 2026**.
- **Closed:** ship the billing fix to staging.
- **Closed:** draft the customer-facing fix summary for Marlowe.

Emphasize the distinction: shipping to staging and drafting the summary are complete, but production verification is not — the concrete unresolved deployment/verification loop that anchors this week's coding thread.

## 3:15-4:30 — Context Archaeology

Ask:

> How did the Marlowe billing fix evolve, and why did the customer call move?

The report should order evidence chronologically:

1. **January 8:** duplicate line items reported on split-shipment invoices; the standing Wednesday 2:00 PM review call is captured.
2. **April 3:** a related proration bug expands the fix scope; the fix is blocked, not proven abandoned.
3. **June 18:** the fix ships to staging; the review call moves from Wednesday 2:00 PM to Thursday 10:00 AM.
4. **August 1:** verification restarts; the fix is in production and the summary is drafted, but the invoice-run check remains unresolved.

Show separate timeline, known, inferred, unknown, and unresolved sections with source/message provenance.

## 4:30-5:30 — Memory Gardener correction

Open review proposals. Show the reviewable supersession:

> Move the Marlowe billing review call from Wednesday 2:00 PM to Thursday 10:00 AM. Preserve Wednesday as historical context.

Accept the proposal if demonstrating the action flow. Verify that Wednesday 2:00 PM remains historical evidence and Thursday 10:00 AM is current; no global memory file is silently edited.

## 5:30-6:30 — Serendipity Engine

Show the proposed `bridge` connection:

> The Marlowe billing fix may be why Marlowe's retainer invoice is overdue.

The explanation should cite both the invoice-follow-up and billing-fix threads, specifically that Marlowe's AP contact is waiting on the fix landing in production. Label it a hypothesis/proposal, not a fact or automatic action — this is the demo's one precise cross-thread connection, and it stays a proposal until reviewed.

Dismiss it once, reprocess, and show dismissal suppression: the same fingerprint does not return during its cooldown.

## 6:30-7:30 — live stop hook

In a new disposable-workspace conversation, say:

> The Marlowe billing fix is deployed to production. I still need to verify the next invoice run by August 20, 2026.

End the turn. Show one dirty row, then manually execute the declared schedule. The loop stays open because a production deploy is not the same as a verified invoice run. Refer to [`live-stop-hook.md`](./live-stop-hook.md) for timing and failure-open checks.

## 7:30-8:00 — deletion and close

Delete the invoice-notes fixture through the supported conversation deletion path and process once more. Show that its derived records and private index document are removed, repeated cleanup is safe, and stale queued work cannot resurrect it.

Finish with:

```bash
THREADKEEPER_DEMO=1 bun run scripts/demo-verify.ts
THREADKEEPER_DEMO=1 THREADKEEPER_DEMO_CONFIRM_RESET=1 bun run scripts/demo-reset.ts
```

The final reset must be run only after the audience has seen the results and only while the daemon reports the disposable workspace.
