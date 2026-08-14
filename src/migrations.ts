import type { Database } from "bun:sqlite";
import { ThreadkeeperError } from "./errors.ts";

type Migration = { version: number; up: (db: Database) => void };

// Evidence / artifact / proposal / projection separation (see ARCHITECTURE.md):
//   sources, source_revisions            -> immutable evidence
//   pipeline_runs, artifacts, evidence_edges -> immutable interpretation
//   proposals, connections               -> reviewable, mutable status only
//   threads, events, open_loops, claims  -> accepted projections, point back to their artifact/proposal
const SCHEMA_V1 = /* sql */ `
CREATE TABLE schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE conversation_cursors (
  conversation_id TEXT PRIMARY KEY,
  last_processed_message_id TEXT,
  last_processed_at INTEGER,
  last_seen_at INTEGER NOT NULL,
  full_rescan_required INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE dirty_conversations (
  conversation_id TEXT PRIMARY KEY,
  touched_at INTEGER NOT NULL,
  request_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  last_error_code TEXT
);
CREATE INDEX idx_dirty_conversations_next_attempt ON dirty_conversations(next_attempt_at);

CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,
  stable_locator TEXT NOT NULL,
  conversation_id TEXT,
  message_id TEXT,
  role TEXT,
  source_timestamp INTEGER,
  sensitivity TEXT NOT NULL DEFAULT 'normal',
  deleted_at INTEGER,
  UNIQUE(source_type, stable_locator)
);
CREATE INDEX idx_sources_conversation ON sources(conversation_id);
CREATE INDEX idx_sources_deleted ON sources(deleted_at);

CREATE TABLE source_revisions (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  content_hash TEXT NOT NULL,
  captured_at INTEGER NOT NULL,
  content_length INTEGER NOT NULL,
  excerpt TEXT,
  canonical_text TEXT,
  previous_revision_id TEXT REFERENCES source_revisions(id),
  UNIQUE(source_id, content_hash)
);
CREATE INDEX idx_source_revisions_source ON source_revisions(source_id);

CREATE TABLE pipeline_runs (
  id TEXT PRIMARY KEY,
  pipeline_name TEXT NOT NULL,
  pipeline_version TEXT NOT NULL,
  prompt_version TEXT,
  model_name TEXT,
  config_hash TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  status TEXT NOT NULL,
  error_code TEXT,
  input_fingerprint TEXT NOT NULL,
  UNIQUE(pipeline_name, pipeline_version, config_hash, input_fingerprint)
);
CREATE INDEX idx_pipeline_runs_status ON pipeline_runs(status);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  artifact_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  epistemic_type TEXT NOT NULL,
  extractor_confidence REAL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_artifacts_run ON artifacts(run_id);
CREATE INDEX idx_artifacts_type ON artifacts(artifact_type);

CREATE TABLE evidence_edges (
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  source_revision_id TEXT NOT NULL REFERENCES source_revisions(id) ON DELETE CASCADE,
  relation TEXT NOT NULL,
  locator_json TEXT,
  evidence_quality REAL,
  PRIMARY KEY(artifact_id, source_revision_id, relation)
);
CREATE INDEX idx_evidence_edges_revision ON evidence_edges(source_revision_id);

CREATE TABLE threads (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  normalized_title TEXT NOT NULL,
  summary TEXT,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER
);
CREATE INDEX idx_threads_status ON threads(status);
CREATE INDEX idx_threads_normalized_title ON threads(normalized_title);

CREATE TABLE thread_memberships (
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  membership_type TEXT NOT NULL,
  confidence REAL,
  PRIMARY KEY(thread_id, object_type, object_id)
);
CREATE INDEX idx_thread_memberships_object ON thread_memberships(object_type, object_id);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  occurred_at INTEGER,
  status TEXT NOT NULL,
  created_from_artifact_id TEXT REFERENCES artifacts(id),
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_events_thread ON events(thread_id);
CREATE INDEX idx_events_occurred ON events(occurred_at);

CREATE TABLE open_loops (
  id TEXT PRIMARY KEY,
  thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL,
  description TEXT NOT NULL,
  next_action TEXT,
  status TEXT NOT NULL,
  due_at INTEGER,
  origin_type TEXT NOT NULL,
  confidence REAL,
  created_from_artifact_id TEXT REFERENCES artifacts(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_open_loops_thread ON open_loops(thread_id);
CREATE INDEX idx_open_loops_status ON open_loops(status);
CREATE INDEX idx_open_loops_due ON open_loops(due_at);

CREATE TABLE claims (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  predicate TEXT NOT NULL,
  object_json TEXT NOT NULL,
  epistemic_type TEXT NOT NULL,
  valid_from INTEGER,
  valid_to INTEGER,
  status TEXT NOT NULL,
  supersedes_claim_id TEXT REFERENCES claims(id),
  created_from_artifact_id TEXT REFERENCES artifacts(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_claims_subject_predicate ON claims(subject, predicate);
CREATE INDEX idx_claims_status ON claims(status);

CREATE TABLE proposals (
  id TEXT PRIMARY KEY,
  proposal_type TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  operation TEXT NOT NULL,
  proposed_payload_json TEXT NOT NULL,
  status TEXT NOT NULL,
  fingerprint TEXT NOT NULL UNIQUE,
  confidence_json TEXT NOT NULL,
  created_by_run_id TEXT REFERENCES pipeline_runs(id),
  reviewed_at INTEGER,
  rejection_reason TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER
);
CREATE INDEX idx_proposals_status ON proposals(status);
CREATE INDEX idx_proposals_target ON proposals(target_type, target_id);

CREATE TABLE connections (
  id TEXT PRIMARY KEY,
  from_type TEXT NOT NULL,
  from_id TEXT NOT NULL,
  to_type TEXT NOT NULL,
  to_id TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  explanation TEXT NOT NULL,
  score_json TEXT NOT NULL,
  status TEXT NOT NULL,
  fingerprint TEXT NOT NULL UNIQUE,
  created_by_run_id TEXT REFERENCES pipeline_runs(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER
);
CREATE INDEX idx_connections_status ON connections(status);

CREATE TABLE feedback (
  id TEXT PRIMARY KEY,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  feedback_type TEXT NOT NULL,
  reason TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_feedback_target ON feedback(target_type, target_id);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  job_type TEXT NOT NULL,
  input_json TEXT NOT NULL,
  output_json TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  lease_until INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  next_attempt_at INTEGER,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_jobs_status ON jobs(status, next_attempt_at);

CREATE TABLE index_documents (
  document_id TEXT PRIMARY KEY,
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  indexed_at INTEGER NOT NULL
);
CREATE INDEX idx_index_documents_owner ON index_documents(owner_type, owner_id);

CREATE TABLE tombstones (
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  deletion_generation INTEGER NOT NULL,
  deleted_at INTEGER NOT NULL,
  purge_status TEXT NOT NULL,
  PRIMARY KEY(target_type, target_id, deletion_generation)
);
CREATE INDEX idx_tombstones_target ON tombstones(target_type, target_id);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  request_id TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_audit_events_created ON audit_events(created_at);
`;

const MIGRATIONS: Migration[] = [{ version: 1, up: (db) => db.exec(SCHEMA_V1) }];

/**
 * Apply every migration newer than `PRAGMA user_version`, each in its own transaction so an
 * interrupted migration rolls back instead of leaving a half-applied schema. Restartable: a
 * later call only applies what is still pending. Never destructive — migrations are additive.
 */
export function runMigrations(db: Database): void {
  let currentVersion: number;
  try {
    const row = db.query("PRAGMA user_version").get() as { user_version: number };
    currentVersion = row.user_version;
  } catch (cause) {
    throw new ThreadkeeperError("MIGRATION_FAILED", `could not read schema version: ${(cause as Error).message}`);
  }
  const pending = MIGRATIONS.filter((m) => m.version > currentVersion).sort((a, b) => a.version - b.version);
  for (const migration of pending) {
    try {
      db.transaction(() => {
        migration.up(db);
        db.exec(`PRAGMA user_version = ${migration.version}`);
      })();
    } catch (cause) {
      throw new ThreadkeeperError(
        "MIGRATION_FAILED",
        `migration ${migration.version} failed: ${(cause as Error).message}`,
      );
    }
  }
}

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;
