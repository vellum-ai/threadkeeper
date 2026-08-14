/**
 * Review-action materialization: what happens when a user accepts, rejects, snoozes, or otherwise
 * acts on a proposal, connection, open loop, or thread. Every mutation here is a deliberate,
 * user-confirmed action — nothing in this file runs unprompted. A connection never automatically
 * becomes memory, a task, a notification, or an external action (plan §13).
 */
import type { Database } from "bun:sqlite";
import { ThreadkeeperError } from "./errors.ts";
import { getConnection, getProposal, recordFeedback, reviewProposal, setConnectionStatus } from "./repositories/review.ts";
import { getOpenLoop, getThread, insertClaim, insertOpenLoop, setClaimStatus, setThreadStatus, updateOpenLoop } from "./repositories/projections.ts";

export interface ReviewActionInput {
  action: string;
  targetId: string;
  reason?: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function applyProposalAcceptance(db: Database, proposalId: string, now: number): Record<string, unknown> {
  const proposal = getProposal(db, proposalId);
  if (!proposal) throw new ThreadkeeperError("NOT_FOUND", `proposal ${proposalId} not found`);
  if (proposal.status !== "pending") return { alreadyReviewed: true, status: proposal.status };
  const payload = JSON.parse(proposal.proposed_payload_json) as Record<string, unknown>;

  switch (proposal.proposal_type) {
    case "create_open_loop": {
      const loop = insertOpenLoop(
        db,
        {
          threadId: (payload.threadId as string | null) ?? null,
          description: String(payload.description ?? ""),
          nextAction: (payload.nextAction as string | null) ?? null,
          dueAt: (payload.dueAt as number | null) ?? null,
          originType: "inferred",
          confidence: 1,
          createdFromArtifactId: (payload.artifactId as string | null) ?? null,
        },
        now,
      );
      reviewProposal(db, proposalId, "accepted", null, now);
      return { createdOpenLoopId: loop.id };
    }
    case "close_loop": {
      const matchedLoopId = (payload.matchedLoopId as string | null) ?? proposal.target_id;
      if (matchedLoopId) updateOpenLoop(db, matchedLoopId, { status: "done" }, now);
      reviewProposal(db, proposalId, "accepted", null, now);
      return { closedOpenLoopId: matchedLoopId ?? null };
    }
    case "create_claim": {
      const temporalStatus = String(payload.temporalStatus ?? "current");
      const claim = insertClaim(
        db,
        {
          subject: String(payload.subject),
          predicate: String(payload.predicate),
          object: payload.object,
          epistemicType: String(payload.epistemicType ?? "interpretation"),
          validFrom: null,
          validTo: null,
          status: temporalStatus === "historical" ? "historical" : "active",
          supersedesClaimId: null,
          createdFromArtifactId: (payload.artifactId as string | null) ?? null,
        },
        now,
      );
      reviewProposal(db, proposalId, "accepted", null, now);
      return { createdClaimId: claim.id };
    }
    case "supersede_claim": {
      const oldClaimId = (payload.supersedesClaimId as string | null) ?? proposal.target_id;
      const claim = insertClaim(
        db,
        {
          subject: String(payload.subject),
          predicate: String(payload.predicate),
          object: payload.object,
          epistemicType: String(payload.epistemicType ?? "interpretation"),
          validFrom: null,
          validTo: null,
          status: "active",
          supersedesClaimId: oldClaimId,
          createdFromArtifactId: (payload.artifactId as string | null) ?? null,
        },
        now,
      );
      if (oldClaimId) setClaimStatus(db, oldClaimId, "superseded", now);
      reviewProposal(db, proposalId, "accepted", null, now);
      return { createdClaimId: claim.id, supersededClaimId: oldClaimId ?? null };
    }
    case "mark_historical": {
      const claimId = (payload.claimId as string | null) ?? proposal.target_id;
      if (claimId) setClaimStatus(db, claimId, "historical", now);
      reviewProposal(db, proposalId, "accepted", null, now);
      return { markedHistoricalClaimId: claimId ?? null };
    }
    case "merge_duplicates": {
      const claimId = (payload.claimId as string | null) ?? proposal.target_id;
      if (claimId) setClaimStatus(db, claimId, "superseded", now);
      reviewProposal(db, proposalId, "accepted", null, now);
      return { mergedClaimId: claimId ?? null };
    }
    case "archive_thread": {
      const threadId = (payload.threadId as string | null) ?? proposal.target_id;
      if (threadId) setThreadStatus(db, threadId, "archived", now);
      reviewProposal(db, proposalId, "accepted", null, now);
      return { archivedThreadId: threadId ?? null };
    }
    case "reopen_loop": {
      const loopId = (payload.loopId as string | null) ?? proposal.target_id;
      if (loopId) updateOpenLoop(db, loopId, { status: "open" }, now);
      reviewProposal(db, proposalId, "accepted", null, now);
      return { reopenedLoopId: loopId ?? null };
    }
    case "update_claim": {
      const claimId = (payload.claimId as string | null) ?? proposal.target_id;
      reviewProposal(db, proposalId, "accepted", null, now);
      return { updatedClaimId: claimId ?? null };
    }
    default:
      reviewProposal(db, proposalId, "accepted", null, now);
      return {};
  }
}

export function runReviewAction(db: Database, input: ReviewActionInput, now = Date.now()): Record<string, unknown> {
  const { action, targetId, reason = null } = input;

  switch (action) {
    case "accept_proposal":
      return { action, targetId, ...applyProposalAcceptance(db, targetId, now) };

    case "reject_proposal": {
      const proposal = getProposal(db, targetId);
      if (!proposal) throw new ThreadkeeperError("NOT_FOUND", `proposal ${targetId} not found`);
      if (proposal.status === "pending") reviewProposal(db, targetId, "rejected", reason, now);
      recordFeedback(db, "proposal", targetId, "rejected", reason, now);
      return { action, targetId, status: "rejected" };
    }

    case "snooze": {
      const loop = getOpenLoop(db, targetId);
      if (loop) updateOpenLoop(db, targetId, { due_at: (loop.due_at ?? now) + 7 * DAY_MS }, now);
      recordFeedback(db, loop ? "open_loop" : "proposal", targetId, "snoozed", reason, now);
      return { action, targetId, snoozedUntilOffsetDays: 7 };
    }

    case "mark_done": {
      const loop = getOpenLoop(db, targetId);
      if (loop) {
        updateOpenLoop(db, targetId, { status: "done" }, now);
        return { action, targetId, targetType: "open_loop" };
      }
      const thread = getThread(db, targetId);
      if (thread) {
        setThreadStatus(db, targetId, "done", now);
        return { action, targetId, targetType: "thread" };
      }
      throw new ThreadkeeperError("NOT_FOUND", `no open loop or thread ${targetId}`);
    }

    case "archive_thread": {
      const thread = getThread(db, targetId);
      if (!thread) throw new ThreadkeeperError("NOT_FOUND", `thread ${targetId} not found`);
      setThreadStatus(db, targetId, "archived", now);
      return { action, targetId };
    }

    case "explore": {
      recordFeedback(db, "connection", targetId, "explored", reason, now);
      return { action, targetId };
    }

    case "save_as_hypothesis": {
      const connection = getConnection(db, targetId);
      if (!connection) throw new ThreadkeeperError("NOT_FOUND", `connection ${targetId} not found`);
      setConnectionStatus(db, targetId, "accepted");
      recordFeedback(db, "connection", targetId, "saved_as_hypothesis", reason, now);
      return { action, targetId, status: "accepted" };
    }

    case "create_open_loop": {
      const connection = getConnection(db, targetId);
      if (!connection) throw new ThreadkeeperError("NOT_FOUND", `connection ${targetId} not found`);
      const threadId = connection.from_type === "thread" ? connection.from_id : connection.to_type === "thread" ? connection.to_id : null;
      const loop = insertOpenLoop(
        db,
        { threadId, description: connection.explanation, nextAction: null, dueAt: null, originType: "direct", confidence: 1, createdFromArtifactId: null },
        now,
      );
      setConnectionStatus(db, targetId, "accepted");
      return { action, targetId, createdOpenLoopId: loop.id };
    }

    case "dismiss_connection": {
      const connection = getConnection(db, targetId);
      if (!connection) throw new ThreadkeeperError("NOT_FOUND", `connection ${targetId} not found`);
      setConnectionStatus(db, targetId, "dismissed");
      recordFeedback(db, "connection", targetId, "dismissed", reason, now);
      return { action, targetId, status: "dismissed" };
    }

    case "mark_wrong": {
      const connection = getConnection(db, targetId);
      if (!connection) throw new ThreadkeeperError("NOT_FOUND", `connection ${targetId} not found`);
      setConnectionStatus(db, targetId, "wrong");
      recordFeedback(db, "connection", targetId, "wrong", reason, now);
      return { action, targetId, status: "wrong" };
    }

    default:
      throw new ThreadkeeperError("ROUTE_VALIDATION_FAILED", `unsupported review action: ${action}`);
  }
}
