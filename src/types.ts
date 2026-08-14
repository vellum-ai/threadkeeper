// Domain row shapes and shared enums. Extraction/archaeology payload shapes and their
// runtime validators live in validation.ts (zod-backed) to keep the schema and the type
// it produces defined in exactly one place.

export type EpistemicType = "direct_fact" | "preference" | "intent" | "interpretation" | "hypothesis";
export type OriginType = "direct" | "inferred";
export type ThreadStatus = "active" | "blocked" | "done" | "archived" | "dormant";
export type OpenLoopStatus = "open" | "blocked" | "done" | "dismissed";
export type ClaimStatus = "active" | "historical" | "superseded" | "rejected";
export type ProposalStatus = "pending" | "accepted" | "rejected" | "expired" | "superseded";
export type ConnectionStatus = "pending" | "accepted" | "dismissed" | "wrong";

export type ProposalType =
  | "create_claim"
  | "update_claim"
  | "supersede_claim"
  | "mark_historical"
  | "merge_duplicates"
  | "reopen_loop"
  | "close_loop"
  | "create_open_loop"
  | "archive_thread";

export type ConnectionType =
  | "convergence"
  | "reuse"
  | "tension"
  | "recurrence"
  | "bridge"
  | "timing"
  | "compression"
  | "contradiction";

export type BackfillPreset = "future_only" | "last_30_days" | "last_90_days" | "all";
export type BackfillScope =
  | { kind: "preset"; preset: BackfillPreset }
  | { kind: "days"; days: number }
  | { kind: "range"; startDate: string; endDate: string };
export interface BackfillScopeInput {
  mode?: string;
  scope?: unknown;
  backfillScope?: unknown;
  days?: unknown;
  dayCount?: unknown;
  startDate?: unknown;
  endDate?: unknown;
  confirmAllHistory?: boolean;
  allowAllHistory?: boolean;
}

export type JobKind = "archaeology" | "rebuild_index" | "backfill" | "review_action";
export type JobStatus = "pending" | "running" | "succeeded" | "failed";

export interface ConfidenceComponents {
  extraction: number;
  evidence_quality: number;
  source_independence: number;
  recency: number;
  user_confirmation: number;
  contradiction_penalty: number;
  risk: "low" | "medium" | "high";
}

export interface ScoreComponents {
  relevance: number;
  novelty: number;
  specificity: number;
  actionability: number;
  evidence_strength: number;
  source_independence: number;
  recurrence: number;
  timing: number;
  genericity_penalty: number;
  sensitivity_penalty: number;
  repetition_penalty: number;
  final: number;
}

export interface SourceRow {
  id: string;
  source_type: string;
  stable_locator: string;
  conversation_id: string | null;
  message_id: string | null;
  role: string | null;
  source_timestamp: number | null;
  sensitivity: string;
  deleted_at: number | null;
}

export interface SourceRevisionRow {
  id: string;
  source_id: string;
  content_hash: string;
  captured_at: number;
  content_length: number;
  excerpt: string | null;
  canonical_text: string | null;
  previous_revision_id: string | null;
}

export interface PipelineRunRow {
  id: string;
  pipeline_name: string;
  pipeline_version: string;
  prompt_version: string | null;
  model_name: string | null;
  config_hash: string;
  started_at: number;
  completed_at: number | null;
  status: string;
  error_code: string | null;
  input_fingerprint: string;
}

export interface ArtifactRow {
  id: string;
  run_id: string;
  artifact_type: string;
  payload_json: string;
  epistemic_type: string;
  extractor_confidence: number | null;
  created_at: number;
}

export interface ThreadRow {
  id: string;
  title: string;
  normalized_title: string;
  summary: string | null;
  status: ThreadStatus;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

export interface EventRow {
  id: string;
  thread_id: string | null;
  event_type: string;
  title: string;
  description: string | null;
  occurred_at: number | null;
  status: string;
  created_from_artifact_id: string | null;
  created_at: number;
}

export interface OpenLoopRow {
  id: string;
  thread_id: string | null;
  description: string;
  next_action: string | null;
  status: OpenLoopStatus;
  due_at: number | null;
  origin_type: OriginType;
  confidence: number | null;
  created_from_artifact_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface ClaimRow {
  id: string;
  subject: string;
  predicate: string;
  object_json: string;
  epistemic_type: string;
  valid_from: number | null;
  valid_to: number | null;
  status: ClaimStatus;
  supersedes_claim_id: string | null;
  created_from_artifact_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface ProposalRow {
  id: string;
  proposal_type: ProposalType;
  target_type: string | null;
  target_id: string | null;
  operation: string;
  proposed_payload_json: string;
  status: ProposalStatus;
  fingerprint: string;
  confidence_json: string;
  created_by_run_id: string | null;
  reviewed_at: number | null;
  rejection_reason: string | null;
  created_at: number;
  expires_at: number | null;
}

export interface ConnectionRow {
  id: string;
  from_type: string;
  from_id: string;
  to_type: string;
  to_id: string;
  relation_type: ConnectionType;
  explanation: string;
  score_json: string;
  status: ConnectionStatus;
  fingerprint: string;
  created_by_run_id: string | null;
  created_at: number;
  expires_at: number | null;
}

export interface JobRow {
  id: string;
  job_type: JobKind;
  input_json: string;
  output_json: string | null;
  idempotency_key: string;
  status: JobStatus;
  lease_until: number | null;
  attempts: number;
  max_attempts: number;
  next_attempt_at: number | null;
  last_error_code: string | null;
  created_at: number;
  updated_at: number;
}
