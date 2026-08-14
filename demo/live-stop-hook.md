# Live stop-hook verification (separate from fixture backfill)

This procedure verifies the real `stop` lifecycle path. Do not substitute `demo-seed`: imported fixtures bypass the normal stop hook.

## Preconditions

1. Build/install Threadkeeper in a disposable assistant workspace only, for example:
    `<workspace>/data/threadkeeper-demo-workspace`.
2. Start the assistant daemon against that workspace. Confirm:

   ```bash
   assistant status --json
   # .workspace must be the disposable workspace path
   assistant plugins inspect threadkeeper --json
   assistant schedules list --json
   ```

3. Confirm the plugin reports `status: ok`, the stop hook is present, and the process-queue schedule is attributed to Threadkeeper.

## One-turn check

Create a normal conversation in the disposable assistant and send exactly one user turn:

> For the Marlowe billing fix, production deploy is done. I still need to verify the next invoice run by August 20, 2026.

After the turn commits, inspect Threadkeeper status or the plugin database through its supported tool/route. Expected:

- exactly one dirty-conversation row for that conversation (repeated stop events upsert, not duplicate);
- no model call, broad history scan, or embedding work in the stop hook;
- the normal assistant reply completes even if Threadkeeper storage is unavailable;
- the hook's measured warm latency p95 is below 20 ms.

Then execute the real declared schedule, not only a direct tool call:

```bash
assistant schedules list --json
assistant schedules execute <threadkeeper-process-queue-id> --json
assistant schedules runs <threadkeeper-process-queue-id> --limit 5 --json
```

The processor should ingest the live conversation and update the invoice-verification loop with due date `2026-08-20`. It must **not** close the loop: a production deploy is not the same as a verified invoice run.

## Failure-open checks

Run the one-turn check with each dependency fault injected by the implementation's test seam or provider/index stub:

1. provider unavailable;
2. malformed provider output;
3. private index unavailable;
4. database unavailable.

For each, assert that the assistant turn still returns normally, the failure is structured/retryable, and no raw transcript appears in structured logs. A successful SQLite commit with a failed derived index is acceptable; a failed index must be rebuildable.

## Idempotency and deletion

- Execute the schedule a second time with no new messages: no duplicate source, revision, proposal, loop, or connection.
- Trigger the supported conversation deletion path for the live test conversation, then run the processor again.
- Assert its source-derived state and private index document are gone; a stale queued job cannot resurrect them.
- Repeat deletion cleanup to confirm it is idempotent.

## Record results

Capture only counts, IDs, statuses, timings, error codes, and provenance locators. Do not paste raw fixture or private conversation text into logs. Record the result next to the release QA notes, not in `demo/state.json` if the workspace is shared.
