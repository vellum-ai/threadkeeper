# Threadkeeper Privacy

## Scope

Threadkeeper v1 is conversations-first. Workspace-file and saved-link ingestion are disabled by default and are not implemented as implicit broad search.

## Local ownership

Canonical state is stored in the plugin's own `data/` directory. Threadkeeper does not write to the assistant's global memory files or internal assistant database.

## Model inputs

Only bounded evidence packets needed for extraction or archaeology are sent through the workspace's configured inference provider. Prompts classify all source material as untrusted data. Credentials, secrets, unnecessary full transcripts, and secret-bearing URLs must not be included.

## Indexing

The private semantic index contains derived summaries and accepted, source-backed objects. It does not contain credentials, raw identity numbers, or unnecessary complete transcripts. The index is isolated to Threadkeeper and is treated as disposable derived state.

## Sensitive information

Sensitive inferred claims always require review. Sensitive categories are excluded from serendipity by default. Threadkeeper never automatically merges identities based on embeddings.

## Logging

Structured logs may contain internal object IDs, durations, counts, and stable error codes. Logs must not contain raw conversation text, full prompts or completions, credentials, full embedding inputs, or personal identifiers beyond internal IDs needed to debug a failure.

## Deletion and retention

Deleting a conversation triggers deletion propagation through source revisions, evidence, unsupported proposals, queue state, projections, and private index documents. Cleanup is idempotent. Configured excerpt and audit retention limits are enforced by maintenance work without deleting accepted user decisions.

Uninstalling Threadkeeper removes the plugin directory and plugin-owned database. Back up the plugin `data/` directory before uninstall if continuity should be preserved.
