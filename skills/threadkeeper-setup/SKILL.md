---
name: threadkeeper-setup
description: >-
  Configure Threadkeeper, including an explicit, changeable conversation backfill scope,
  serendipity setting, and sensitive-category privacy default. Use when the user asks to set up,
  enable, configure, or backfill Threadkeeper.
metadata:
  emoji: "🧵"
  vellum:
    category: "productivity"
    display-name: "Threadkeeper Setup"
    activation-hints:
      - "User asks to set up or configure Threadkeeper"
      - "User asks Threadkeeper to backfill old conversations"
      - "User asks whether Threadkeeper should include sensitive topics"
    avoid-when:
      - "User only wants to review existing loops or proposals"
      - "User asks a historical project question; use context-archaeologist"
---

# Threadkeeper setup

Configure conservatively. Do not begin a historical backfill merely because the plugin is installed.
The scope is a runtime preference and can be changed later without reinstalling the plugin.

## Backfill scope choices

Choose exactly one scope when starting or changing a backfill:

- `future_only` (recommended safest default)
- `last_30_days`
- `last_90_days`
- `all` (unsafe broad scan; requires explicit `confirmAllHistory: true`)
- a custom positive integer day count, for example `{ "days": 45 }`
- an explicit inclusive ISO date range, for example `{ "startDate": "2026-01-01", "endDate": "2026-03-31" }`

Date ranges use conversation `updatedAt`, include both calendar endpoints, and require valid `YYYY-MM-DD` dates with the start on or before the end. Custom day counts are positive integers from 1 through 36,500.

Also ask whether serendipity should be enabled. Sensitive categories are excluded by default; only enable them after the user explicitly asks.

## Procedure

1. Explain that Threadkeeper keeps its own SQLite state and private derived index; it does not write directly to global assistant memory.
2. Capture and validate the explicit backfill scope before queueing work.
3. Use the `threadkeeper` tool with `start_backfill` and the selected scope fields. Use `backfillMode` only for fixed presets; use `days` or `startDate`/`endDate` for custom scopes.
4. Never process the entire backfill in the setup turn. The scan itself is page-bounded and normal conversation processing remains bounded by the queue schedule.
5. Confirm the returned job or queued status without claiming that processing is complete.
6. Tell the user where to review progress: the Threadkeeper dashboard's System status and Archaeology sections.
7. If the user chooses `all`, repeat that it is an explicit all-history operation, is capped per scan, and may require multiple runs or a narrower scope.
8. To change scope later, run `start_backfill` again with the new scope; no reinstall is needed. A new validated scope creates a distinct idempotent job.

## Privacy and safety

- Keep sensitive categories excluded unless explicitly enabled.
- Never expose raw conversation content in setup summaries or logs.
- Do not write global memory, send notifications, or take external actions as a side effect of setup.
