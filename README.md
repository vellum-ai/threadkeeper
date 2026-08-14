# Threadkeeper

Threadkeeper maintains evidence-backed continuity across conversations. It tracks unfinished commitments, reconstructs how projects and decisions changed, proposes corrections to stale claims, and surfaces precise cross-thread connections.

## What it ships

- Fast lifecycle hooks for durable change capture and deletion propagation.
- A bounded background queue processor backed by plugin-owned SQLite.
- One compact `threadkeeper` tool with status, search, review, archaeology, processing, and action modes.
- Setup, Context Archaeologist, and review skills.
- A quiet recurring queue schedule.
- Bounded HTTP routes and a responsive review dashboard.
- A separate, resettable Product Launch demo dataset.

## Install

Install directly from the Vellum AI repository:

```bash
assistant plugins install vellum-ai/threadkeeper --name threadkeeper
```

The CLI identifies direct GitHub installs as unreviewed until Threadkeeper is listed in the curated Vellum marketplace. Confirm the installation with:

```bash
assistant plugins list
assistant plugins inspect threadkeeper
```

Threadkeeper declares a recurring queue-processing schedule. The installer shows the schedule before enabling it.

Each installation starts with fresh, private state. Repository installs never include another user's conversations, claims, proposals, configuration history, or SQLite databases.

## First-run defaults

Threadkeeper begins in `future_only` mode. It captures new conversations after installation but does not scan historical conversations automatically. Historical backfill must be selected explicitly through the Threadkeeper Setup skill or the `start_backfill` tool action.

Serendipity is enabled by default, while sensitive categories are excluded. Workspace-file ingestion and automatic context injection are disabled by default.

## Safety model

- SQLite is canonical. The private semantic index is a rebuildable cache.
- Evidence and extraction artifacts are immutable.
- Inferred or sensitive claims remain proposals until accepted.
- Connections are hypotheses. They never become global memory, tasks, notifications, or external actions automatically.
- Rejected fingerprints are suppressed until materially new evidence appears.
- Conversation deletion propagates through sources, projections, jobs, and index documents.
- Hook, provider, index, and worker failures fail open so ordinary conversation continues.

## Storage and privacy

Runtime state is created at `InitContext.pluginStorageDir/threadkeeper.sqlite`. For an installed user plugin this resolves to `plugins/threadkeeper/data/threadkeeper.sqlite`.

The Product Launch demo uses a physically separate `threadkeeper-demo.sqlite` file and never replaces or writes through the live database singleton. Both databases are generated locally and excluded from Git.

Uninstalling the plugin removes its directory and plugin-owned data. Back up the `data/` directory first if the history should be retained. See [PRIVACY.md](./PRIVACY.md) for the complete data-handling model.

## Backfill scope

Use the `start_backfill` action to choose or change scope later without reinstalling:

- Fixed presets: `future_only`, `last_30_days`, `last_90_days`, and `all`.
- Custom positive day count: `{ "days": 45 }` (1 through 36,500).
- Explicit inclusive ISO date range: `{ "startDate": "2026-01-01", "endDate": "2026-03-31" }`, filtered by conversation `updatedAt`.

`all` requires `confirmAllHistory: true`. Each invocation scans at most 5,000 conversations, and processing remains bounded by the normal queue schedule. A later `start_backfill` call replaces the selected scope.

## Development

Bun is required because Threadkeeper uses `bun:sqlite`.

```bash
bun install
bun run build:app
bun run typecheck
bun test
```

The Vellum plugin app watcher builds `apps/threadkeeper/src` automatically for installed plugins. `apps/threadkeeper/dist` is generated and is not committed.

For the deterministic fixture harness:

```bash
bun run demo:validate
bun run demo:all
```

The fixture commands that touch conversations require a disposable assistant workspace. Read `demo/RUNBOOK.md` before running them.

## Updating a direct GitHub installation

```bash
assistant plugins upgrade threadkeeper
```

Direct GitHub installations track the repository ref recorded at install time. Marketplace releases, once available, are pinned to reviewed immutable commits.
