---
name: threadkeeper-review
description: >-
  Review Threadkeeper open loops, memory-gardener proposals, contradictions, and serendipity
  connection hypotheses. Use when the user asks what needs review, wants to accept, reject, snooze,
  complete, archive, explore, or dismiss a Threadkeeper item.
metadata:
  emoji: "🪴"
  vellum:
    category: "productivity"
    display-name: "Threadkeeper Review"
    activation-hints:
      - "User asks what Threadkeeper found or what needs review"
      - "User wants to review open loops or memory proposals"
      - "User wants to explore, accept, dismiss, or mark a connection wrong"
      - "User wants to close, snooze, or archive a thread"
    avoid-when:
      - "User asks for a sourced historical reconstruction"
      - "User is configuring initial backfill or privacy settings"
---

# Threadkeeper review

Use the `threadkeeper` tool with `list_open_loops` and `list_reviews` to gather a bounded review set. Present proposal state and accepted state distinctly.

## Review order

1. Active or blocked open loops, especially due or aging items.
2. Gardener proposals and contradictions.
3. Serendipity connections with a clear structural relationship and evidence for both endpoints.
4. Pending archaeology jobs and persistent processing failures.

## Every item needs provenance

For each proposal or connection, show the source conversation, source artifact, date, and evidence label when available. Explain the pattern in plain language. Distinguish directly stated, inferred, conflicted, stale, and weak-hypothesis evidence.

## Actions

- Accept a proposal only after the user confirms it; use `accept_proposal`.
- Reject or dismiss with the user's reason when provided; use `reject_proposal`. Rejections create durable suppression and should not recur without materially new evidence.
- For a connection, offer explore, save as hypothesis, create open loop, dismiss, or mark wrong. A connection never automatically becomes memory, a task, a notification, or an external action.
- Use `snooze`, `mark_done`, or `archive_thread` only for the target the user named.
- Do not expose destructive database purge through this workflow.

After an action, report the queued or accepted state honestly and point the user to the dashboard for provenance and job progress.
