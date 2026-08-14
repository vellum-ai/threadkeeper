# Threadkeeper Architecture

## Execution model

Threadkeeper uses three speeds:

1. **Live capture:** the `stop` hook performs one short SQLite upsert into `dirty_conversations` and returns. It does not read broad history, invoke a model, or write the semantic index.
2. **Background processing:** a quiet recurring schedule calls the `threadkeeper` tool with a bounded job count. Workers ingest finalized messages, commit source revisions, run extraction outside transactions, save immutable artifacts and provenance, update projections, and refresh derived index documents.
3. **Deep retrieval:** archaeology and rebuild operations run only on explicit request. HTTP routes enqueue deep work instead of holding a request open.

## Data boundaries

The durable model separates four layers:

- **Evidence:** sources and immutable source revisions.
- **Interpretation:** pipeline runs, immutable artifacts, and evidence edges.
- **Proposal:** reviewable changes and serendipity hypotheses.
- **Accepted projection:** threads, events, open loops, and claims used as current state.

Every visible derived object must retain a path to evidence. User corrections create new history and supersede old claims rather than erasing the record.

## Queue and idempotency

Dirty conversations are coalesced by conversation ID. Jobs use deterministic idempotency keys, short leases, bounded retries, and tombstone checks before commit. Pipeline runs fingerprint their canonical input and configuration. At-least-once execution is expected, so repeated processing must not create duplicate visible state.

## Conversation ingestion

The worker uses public `@vellumai/plugin-api` conversation functions. Stable source locators combine the Vellum conversation and message IDs. Edited content creates a new immutable revision. Missing cursors trigger safe reconciliation by source ID and content hash.

## Provider and prompt boundary

Model calls use the workspace's configured inference provider. Conversation text, tool results, and external content are delimited as untrusted data. Embedded instructions cannot change the extraction task. Model JSON is runtime-validated and receives at most one repair attempt.

## Private index

`indexDocument`, `queryIndex`, and `removeDocument` operate in Threadkeeper's plugin-scoped index. SQLite remains sufficient to rebuild every document. Index failures never roll back canonical SQLite commits.

## Deletion

Conversation deletion writes a tombstone, removes source-derived state, clears queue and cursor rows, and removes invalid index documents. Clear-all purges all conversation-derived state. Workers check tombstones and leases before final commit so stale work cannot resurrect deleted content.

## User surfaces

The compact tool exposes operations without permanently adding many tools to the model catalog. Skills teach setup, archaeology presentation, and review behavior. Routes perform bounded validation and database work. The dashboard uses `window.vellum.fetch` and presents provenance, accepted state, proposals, and hypotheses as visually distinct categories.

## Dynamic backfill scope

Backfill scope is a validated runtime setting, not an install-time constant. The supported forms are the four fixed presets, a positive day count, or an inclusive ISO date range. The active scope is persisted in `schema_meta` so a later setup or tool action can replace it without reinstalling. `all` requires an explicit confirmation flag. Scans use pages of 100 and stop after 50 pages; normal queue processing remains separately bounded.
