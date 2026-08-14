# Threadkeeper Implementation Notes

## Runtime target

Built against Vellum Assistant and `@vellumai/plugin-api` version `0.11.3-dev.202608130259.289776e`. The peer dependency must use a real compatible range below 1.0.

## Verified runtime behavior

- Installed user-plugin storage is supplied by `InitContext.pluginStorageDir` and currently resolves to `<pluginDir>/data/`.
- Plugin-declared recurring schedules are supported under `schedules/<name>/config.json` plus exactly one `index.md` or `index.sh`.
- Hook functions are awaited. The stop hook is intentionally limited to a short dirty-row upsert.
- Plugin HTTP routes have a 30-second execution limit. Deep work is enqueued.
- Plugin index operations require an active plugin execution context and are isolated by manifest name.
- Plugin app network requests use `window.vellum.fetch`.

## Deliberate reduced scope

- Automatic live context injection is disabled in v1.
- Global assistant-memory synchronization is not implemented because no public write API is used by this design.
- Workspace-file and saved-link ingestion are deferred and opt-in. Conversation search has a documented public facade; broad workspace search does not have an equivalent first-class plugin API.
- No external actions, notifications, or automatic identity merges are performed.

## Schedule cost

The initial schedule runs every 15 minutes and invokes an execute turn even when the queue may be empty. The prompt exits immediately on an empty queue. If measured idle cost is undesirable, reduce the cadence. Do not replace the declared schedule with undocumented internals.

## Distribution

This workspace build is a local user plugin. Marketplace publication requires a separate repository, a full commit SHA, catalog metadata, and review. No external repository or publication action is performed as part of the local build.

## Deliberate reduced-scope decisions made during implementation

These are conservative choices, not gaps in provenance, idempotency, deletion, or failure-open
behavior — every one preserves those guarantees while narrowing feature surface.

- **Claims are always proposals in v1**, never written directly to the `claims` table, including
  direct user statements. Section 10 allows direct auto-creation for low-risk open loops but is
  silent on claims one way or the other; section 0.10 says explicitly to prefer proposals over
  automatic action when in doubt, so claims default to the more conservative path. Only
  `open_loops` with `origin_type = direct` and an unambiguous lexical match materialize
  automatically, matching the plan's explicit example.
- **Repositories are grouped by concern, not one file per table** (`repositories/queue.ts`,
  `evidence.ts`, `projections.ts`, `review.ts`, `audit.ts` — five files covering all fourteen
  tables) to keep the data-access layer navigable. The evidence/artifact/proposal/projection
  separation the plan requires is preserved at the schema and module-boundary level, not the
  file-per-table level the directory sketch implied.
- **Archaeology's lexical fallback only resolves messages Threadkeeper has already ingested.**
  `searchMessageIdsLexical` returns `{messageId, score}` with no conversation id, and there is no
  public "conversation for message id" lookup. A lexical hit is resolved via Threadkeeper's own
  `sources` table (keyed by message id from ingestion); a hit for a message no source has ever been
  created for is skipped rather than guessed at. In practice this only affects conversations that
  have never been through the queue at all — usually a strict subset of what a well-processed
  workspace would have anyway.
- **Gardener's deterministic checks cover contradictory/duplicate active claims, expired claims,
  and claims whose only evidence was deleted** — not the full six-item list in plan §12. "A
  rejected proposal being regenerated without new evidence" is covered globally by fingerprint
  suppression (every proposal/connection creation path checks it), not as a separate gardener scan.
  "A dormant condition that has been satisfied" would require cross-thread completion correlation
  beyond what a deterministic sweep can safely infer; deferred.
- **Conversation deletion does not hard-delete `artifacts` rows.** Deleting an artifact whose id is
  still referenced by `created_from_artifact_id` on an event/open_loop/claim would violate the
  foreign key (no `ON DELETE` clause there, intentionally — those references should not silently
  vanish). Instead, deletion propagation: rejects any still-pending proposal whose backing run has
  zero surviving evidence, and proposes (never silently marks) any active claim whose only evidence
  was deleted as historical, via the same Gardener-style path. Artifacts remain as an immutable
  interpretation record even after their evidence is gone, consistent with "artifacts are
  immutable" — what changes is their visible consequences.
- **`jobs.output_json`** was added to the plan's `jobs` table (a single nullable `TEXT` column) so
  archaeology/rebuild_index/backfill/review-action results are retrievable via `getJob` after
  completion. Additive, does not change any documented column.
- **Retention (`config.retention.rawExcerptDays` / `runAuditDays`) is accepted and validated but not
  enforced by a maintenance sweep in v1** — no scheduled purge job exists yet. Configured values are
  inert. Documented here rather than silently ignored.
- **Serendipity's sensitivity check is a keyword heuristic** (health/medical/therapy/relationship/
  finance/etc. substring match on the canonical thread document), not a structured sensitivity tag
  on claims/threads — the schema has no such column. Precision-first: this likely over-excludes
  more than a principled tagger would, which is the safe direction for a default-off feature.
- **The stop hook's `dirty_conversations.request_id` is always `null`.** `StopContext` (unlike the
  plan's pseudocode) has no `requestId` field — only `conversationId`, `messages`, `exitReason`,
  `error`, `logger`, `broadcast`. There is also no available signal to identify "internal
  maintenance conversations" to skip, so that filter from plan §8 step 2 is not implemented; every
  conversation's stop event is captured.
- **Live demo execution was not run in this session.** The Northstar demo seeds real conversations
  into a real running assistant and drains real inference calls against them. Doing that requires a
  second assistant daemon bound to a disposable workspace (see `demo/RUNBOOK.md`), which this build
  session did not stand up. `bun install`, `bun run typecheck`, `bun test` (70/70 passing), and the
  read-only `assistant plugins list` / `assistant plugins inspect threadkeeper` checks were run
  instead. The demo scripts and `LIVE-HOOK-PROCEDURE.md` are ready to run once such an instance
  exists.

## Dynamic backfill scope

`src/backfillScope.ts` owns normalization and clear validation for fixed presets, positive custom day counts, and inclusive ISO date ranges. The selected scope is persisted in the plugin-owned `schema_meta` table under `active-backfill-scope`; this is additive and does not touch host conversation state. The historical scan remains enqueue-only, pages 100 conversations at a time, and caps a single invocation at 5,000 conversations. `all` requires `confirmAllHistory: true` at the user-facing action boundary.
