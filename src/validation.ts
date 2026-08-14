/**
 * Runtime validation for every model-produced JSON shape. Nothing downstream ever trusts a
 * `JSON.parse(...) as T` cast — every field is checked against a zod schema before it can create
 * an artifact, proposal, or report.
 */
import { z } from "zod";

const confidence = z.number().min(0).max(1);
const sourceIds = z.array(z.string().min(1)).min(1);

// ─── Structured extraction (plan §9) ─────────────────────────────────────────

const threadCandidateSchema = z.object({
  title: z.string().min(1),
  summary: z.string().default(""),
  existing_thread_hint: z.string().nullable().default(null),
  source_message_ids: sourceIds,
  confidence,
});

const eventSchema = z.object({
  type: z.enum(["idea", "decision", "commitment", "question", "status_change", "correction", "completion", "blocker"]),
  title: z.string().min(1),
  description: z.string().default(""),
  occurred_at: z.string().nullable().default(null),
  epistemic_type: z.enum(["direct_fact", "interpretation", "hypothesis"]),
  source_message_ids: sourceIds,
  confidence,
});

const openLoopCandidateSchema = z.object({
  description: z.string().min(1),
  next_action: z.string().nullable().default(null),
  due_at: z.string().nullable().default(null),
  origin: z.enum(["direct", "inferred"]),
  source_message_ids: sourceIds,
  confidence,
});

const claimCandidateSchema = z.object({
  subject: z.string().min(1),
  predicate: z.string().min(1),
  object: z.unknown(),
  epistemic_type: z.enum(["direct_fact", "preference", "intent", "interpretation", "hypothesis"]),
  temporal_status: z.enum(["current", "historical", "unknown"]),
  source_message_ids: sourceIds,
  confidence,
  sensitive: z.boolean().default(false),
});

const closureCandidateSchema = z.object({
  description: z.string().min(1),
  source_message_ids: sourceIds,
  confidence,
});

export const extractionOutputSchema = z.object({
  turn_summary: z.string().default(""),
  thread_candidates: z.array(threadCandidateSchema).default([]),
  events: z.array(eventSchema).default([]),
  open_loop_candidates: z.array(openLoopCandidateSchema).default([]),
  claim_candidates: z.array(claimCandidateSchema).default([]),
  closure_candidates: z.array(closureCandidateSchema).default([]),
});

export type ExtractionOutput = z.infer<typeof extractionOutputSchema>;
export type ThreadCandidate = z.infer<typeof threadCandidateSchema>;
export type EventCandidate = z.infer<typeof eventSchema>;
export type OpenLoopCandidate = z.infer<typeof openLoopCandidateSchema>;
export type ClaimCandidate = z.infer<typeof claimCandidateSchema>;
export type ClosureCandidate = z.infer<typeof closureCandidateSchema>;

// ─── Archaeology report (plan §11) ───────────────────────────────────────────

const timelineEntrySchema = z.object({
  date: z.string().nullable().default(null),
  title: z.string().min(1),
  description: z.string().default(""),
  source_ids: z.array(z.string()).default([]),
  evidence_type: z.enum(["known", "inferred"]),
});

const assumptionSchema = z.object({
  text: z.string().min(1),
  status: z.enum(["still_holds", "changed", "unknown"]),
  source_ids: z.array(z.string()).default([]),
});

export const archaeologyReportSchema = z.object({
  subject: z.string().min(1),
  current_state: z.string().default(""),
  timeline: z.array(timelineEntrySchema).default([]),
  original_intent: z.string().nullable().default(null),
  decision_reasons: z.array(z.string()).default([]),
  assumptions: z.array(assumptionSchema).default([]),
  scope_changes: z.array(z.string()).default([]),
  unresolved: z.array(z.string()).default([]),
  known: z.array(z.string()).default([]),
  likely_interpretations: z.array(z.string()).default([]),
  unknowns: z.array(z.string()).default([]),
  suggested_next_action: z.string().nullable().default(null),
});

export type ArchaeologyReport = z.infer<typeof archaeologyReportSchema>;

// ─── Serendipity connection explanation (plan §13) ──────────────────────────

export const connectionExplanationSchema = z.object({
  relation_type: z.enum(["convergence", "reuse", "tension", "recurrence", "bridge", "timing", "compression", "contradiction"]),
  explanation: z.string().min(1),
  why_it_may_matter_now: z.string().default(""),
});

export type ConnectionExplanation = z.infer<typeof connectionExplanationSchema>;

// ─── Shared JSON extraction + validation plumbing ───────────────────────────

/** Strip a ```json fence or surrounding prose so a model reply that isn't bare JSON can still parse. */
export function extractJsonCandidate(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : trimmed)?.trim() ?? "";
  if (body.startsWith("{") || body.startsWith("[")) return body;
  const first = body.indexOf("{");
  const last = body.lastIndexOf("}");
  if (first >= 0 && last > first) return body.slice(first, last + 1);
  return body;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

function validateWith<T>(schema: z.ZodType<T>, raw: string): ValidationResult<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonCandidate(raw));
  } catch (cause) {
    return { ok: false, errors: [`invalid JSON: ${(cause as Error).message}`] };
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, errors: result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`) };
  }
  return { ok: true, value: result.data };
}

export function validateExtractionOutput(raw: string): ValidationResult<ExtractionOutput> {
  return validateWith(extractionOutputSchema, raw);
}

export function validateArchaeologyReport(raw: string): ValidationResult<ArchaeologyReport> {
  return validateWith(archaeologyReportSchema, raw);
}

export function validateConnectionExplanation(raw: string): ValidationResult<ConnectionExplanation> {
  return validateWith(connectionExplanationSchema, raw);
}

/**
 * Drop any candidate whose cited source_message_ids are empty or reference a message outside the
 * batch actually sent to the model. A schema-valid candidate can still hallucinate ids; provenance
 * must trace to real evidence, so this runs after schema validation, before anything is persisted.
 */
export function sanitizeExtractionOutput(output: ExtractionOutput, knownMessageIds: ReadonlySet<string>): ExtractionOutput {
  const validIds = (ids: string[]) => ids.length > 0 && ids.every((id) => knownMessageIds.has(id));
  return {
    ...output,
    thread_candidates: output.thread_candidates.filter((c) => validIds(c.source_message_ids)),
    events: output.events.filter((c) => validIds(c.source_message_ids)),
    open_loop_candidates: output.open_loop_candidates.filter((c) => validIds(c.source_message_ids)),
    claim_candidates: output.claim_candidates.filter((c) => validIds(c.source_message_ids)),
    closure_candidates: output.closure_candidates.filter((c) => validIds(c.source_message_ids)),
  };
}
