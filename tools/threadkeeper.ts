import type { ToolContext, ToolExecutionResult } from "@vellumai/plugin-api";
import { normalizeBackfillRequest } from "../src/backfillScope.ts";
import type { BackfillScopeInput } from "../src/types.ts";

type Input = BackfillScopeInput & {
  backfillMode?: string;
  action?: string; query?: string; threadId?: string; proposalId?: string; connectionId?: string;
  status?: string; type?: string; maxJobs?: number; max_jobs?: number; limit?: number; reason?: string;
};
type Core = Record<string, unknown>;

async function loadCore(): Promise<Core> { return (await import("../src/index.ts")) as Core; }
function result(value: unknown): ToolExecutionResult { return { content: JSON.stringify(value), isError: false }; }
function failure(code: string, message: string): ToolExecutionResult { return { content: JSON.stringify({ ok: false, error: { code, message } }), isError: true }; }
function bounded(value: unknown, fallback: number, max: number): number { const n = Number(value); return Number.isFinite(n) ? Math.max(1, Math.min(max, Math.floor(n))) : fallback; }
async function invoke(core: Core, names: string[], ...args: unknown[]): Promise<unknown> {
  for (const name of names) { const fn = core[name]; if (typeof fn === "function") return await (fn as (...xs: unknown[]) => unknown)(...args); }
  throw new Error("CORE_SURFACE_UNAVAILABLE");
}

export default {
  name: "threadkeeper",
  description: "Threadkeeper action dispatcher for open loops, archaeology, memory review, serendipity connections, queue processing, status, and rebuild requests. Use status first when unsure.",
  defaultRiskLevel: "low" as const,
  category: "productivity",
  input_schema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["status", "search", "get_thread", "archaeology", "list_open_loops", "list_reviews", "process_queue", "rebuild_index", "accept_proposal", "reject_proposal", "snooze", "mark_done", "archive_thread", "start_backfill"] },
      query: { type: "string" }, threadId: { type: "string" }, proposalId: { type: "string" }, connectionId: { type: "string" },
      status: { type: "string", enum: ["open", "active", "blocked", "done", "archived", "dormant", "dismissed", "all"] },
      type: { type: "string", enum: ["proposal", "connection", "archaeology", "all"] }, maxJobs: { type: "integer", minimum: 1, maximum: 20 }, max_jobs: { type: "integer", minimum: 1, maximum: 20 }, limit: { type: "integer", minimum: 1, maximum: 50 },
      reason: { type: "string", maxLength: 500 },
      backfillMode: { type: "string", enum: ["future_only", "last_30_days", "last_90_days", "all"] },
      mode: { type: "string", enum: ["future_only", "last_30_days", "last_90_days", "all"] },
      days: { type: "integer", minimum: 1, maximum: 36500 }, dayCount: { type: "integer", minimum: 1, maximum: 36500 },
      startDate: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" }, endDate: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
      confirmAllHistory: { type: "boolean", description: "Required when selecting all history." }, allowAllHistory: { type: "boolean", description: "Alias for confirmAllHistory." },
    }, required: ["action"], additionalProperties: false,
  },
  async execute(raw: Record<string, unknown>, ctx: ToolContext): Promise<ToolExecutionResult> {
    const input = raw as Input; const action = input.action; if (!action) return failure("ROUTE_VALIDATION_FAILED", "action is required");
    try {
      const core = await loadCore(); const limit = bounded(input.limit, 20, 50);
      switch (action) {
        case "status": return result(await invoke(core, ["getStatus", "status"]));
        case "search": { const query = String(input.query ?? "").trim(); if (!query) return failure("ROUTE_VALIDATION_FAILED", "query is required for search"); return result(await invoke(core, ["search", "searchThreadkeeper"], { query, limit })); }
        case "get_thread": if (!input.threadId) return failure("ROUTE_VALIDATION_FAILED", "threadId is required"); return result(await invoke(core, ["getThread"], { id: input.threadId }));
        case "archaeology": { const query = String(input.query ?? "").trim(); if (!query) return failure("ROUTE_VALIDATION_FAILED", "query is required for archaeology"); return result(await invoke(core, ["enqueueArchaeology", "requestArchaeology", "enqueueJob"], { kind: "archaeology", query, threadId: input.threadId, conversationId: ctx.conversationId })); }
        case "list_open_loops": return result(await invoke(core, ["listOpenLoops"], { status: input.status ?? "open", limit }));
        case "list_reviews": return result(await invoke(core, ["listReviews"], { type: input.type ?? "all", limit }));
        case "process_queue": return result(await invoke(core, ["processQueue"], { maxJobs: bounded(input.maxJobs ?? input.max_jobs, 5, 20), trigger: "tool_or_schedule" }));
        case "rebuild_index": return result(await invoke(core, ["enqueueIndexRebuild", "rebuildIndex", "enqueueJob"], { kind: "rebuild_index", conversationId: ctx.conversationId }));
        case "accept_proposal": case "reject_proposal": case "snooze": case "mark_done": case "archive_thread": case "explore": case "save_as_hypothesis": case "create_open_loop": case "dismiss_connection": case "mark_wrong": {
          const targetId = input.proposalId ?? input.threadId ?? input.connectionId; if (!targetId) return failure("ROUTE_VALIDATION_FAILED", "a target id is required");
          return result(await invoke(core, ["enqueueAction", "applyAction", "reviewAction"], { action, targetId, reason: input.reason, conversationId: ctx.conversationId }));
        }
        case "start_backfill": {
          const scopeInput: BackfillScopeInput = { ...input, mode: input.backfillMode ?? input.mode };
          try { normalizeBackfillRequest(scopeInput); } catch (error) { return failure("ROUTE_VALIDATION_FAILED", error instanceof Error ? error.message : "invalid backfill scope"); }
          return result(await invoke(core, ["startBackfill", "enqueueBackfill", "enqueueJob"], { ...scopeInput, conversationId: ctx.conversationId }));
        }
        default: return failure("ROUTE_VALIDATION_FAILED", `unsupported action: ${action}`);
      }
    } catch (cause) {
      const message = cause instanceof Error && cause.message === "CORE_SURFACE_UNAVAILABLE" ? "Threadkeeper core is not ready" : cause instanceof Error && cause.message.includes("backfill") ? cause.message : "Threadkeeper could not complete that action";
      return failure("DB_UNAVAILABLE", message);
    }
  },
};
