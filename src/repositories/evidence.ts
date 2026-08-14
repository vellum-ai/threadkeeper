import type { Database } from "bun:sqlite";
import { newId } from "../ids.ts";
import type { ArtifactRow, PipelineRunRow, SourceRevisionRow, SourceRow } from "../types.ts";

// ─── sources ─────────────────────────────────────────────────────────────────

export interface UpsertSourceInput {
  sourceType: string;
  stableLocator: string;
  conversationId: string | null;
  messageId: string | null;
  role: string | null;
  sourceTimestamp: number | null;
  sensitivity?: string;
}

export function upsertSource(db: Database, input: UpsertSourceInput): SourceRow {
  const id = newId();
  db.query(
    `INSERT INTO sources(id, source_type, stable_locator, conversation_id, message_id, role, source_timestamp, sensitivity)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_type, stable_locator) DO UPDATE SET deleted_at = NULL`,
  ).run(
    id,
    input.sourceType,
    input.stableLocator,
    input.conversationId,
    input.messageId,
    input.role,
    input.sourceTimestamp,
    input.sensitivity ?? "normal",
  );
  return db
    .query(`SELECT * FROM sources WHERE source_type = ? AND stable_locator = ?`)
    .get(input.sourceType, input.stableLocator) as SourceRow;
}

export function getSourceById(db: Database, id: string): SourceRow | null {
  return db.query(`SELECT * FROM sources WHERE id = ?`).get(id) as SourceRow | null;
}

/** Look up a conversation-message source by the Vellum message id (Threadkeeper's own ingestion index). */
export function findSourceByMessageId(db: Database, messageId: string): SourceRow | null {
  return db
    .query(`SELECT * FROM sources WHERE source_type = 'conversation_message' AND stable_locator = ? AND deleted_at IS NULL`)
    .get(messageId) as SourceRow | null;
}

export function listSourcesForConversation(db: Database, conversationId: string): SourceRow[] {
  return db.query(`SELECT * FROM sources WHERE conversation_id = ? AND deleted_at IS NULL`).all(
    conversationId,
  ) as SourceRow[];
}

/** Hard-deletes sources for a conversation; FK cascade removes their revisions and evidence edges. */
export function deleteSourcesForConversation(db: Database, conversationId: string): string[] {
  const ids = (
    db.query(`SELECT id FROM sources WHERE conversation_id = ?`).all(conversationId) as Array<{ id: string }>
  ).map((r) => r.id);
  db.query(`DELETE FROM sources WHERE conversation_id = ?`).run(conversationId);
  return ids;
}

// ─── source_revisions ────────────────────────────────────────────────────────

export interface InsertRevisionInput {
  sourceId: string;
  contentHash: string;
  capturedAt: number;
  contentLength: number;
  excerpt: string | null;
  canonicalText: string | null;
}

/** Idempotent: the same (source, content hash) never creates a second revision. */
export function insertSourceRevision(db: Database, input: InsertRevisionInput): SourceRevisionRow {
  const existing = db
    .query(`SELECT * FROM source_revisions WHERE source_id = ? AND content_hash = ?`)
    .get(input.sourceId, input.contentHash) as SourceRevisionRow | null;
  if (existing) return existing;
  const previous = db
    .query(`SELECT id FROM source_revisions WHERE source_id = ? ORDER BY captured_at DESC LIMIT 1`)
    .get(input.sourceId) as { id: string } | null;
  const id = newId();
  db.query(
    `INSERT INTO source_revisions(id, source_id, content_hash, captured_at, content_length, excerpt, canonical_text, previous_revision_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.sourceId,
    input.contentHash,
    input.capturedAt,
    input.contentLength,
    input.excerpt,
    input.canonicalText,
    previous?.id ?? null,
  );
  return db.query(`SELECT * FROM source_revisions WHERE id = ?`).get(id) as SourceRevisionRow;
}

export function getLatestRevision(db: Database, sourceId: string): SourceRevisionRow | null {
  return db
    .query(`SELECT * FROM source_revisions WHERE source_id = ? ORDER BY captured_at DESC LIMIT 1`)
    .get(sourceId) as SourceRevisionRow | null;
}

export function getRevisionById(db: Database, id: string): SourceRevisionRow | null {
  return db.query(`SELECT * FROM source_revisions WHERE id = ?`).get(id) as SourceRevisionRow | null;
}

// ─── pipeline_runs ───────────────────────────────────────────────────────────

export interface CreateRunInput {
  pipelineName: string;
  pipelineVersion: string;
  promptVersion: string | null;
  modelName: string | null;
  configHash: string;
  inputFingerprint: string;
}

/** Returns the existing run when one already matches this exact (pipeline, config, input) fingerprint. */
export function findOrStartRun(db: Database, input: CreateRunInput, now = Date.now()): { row: PipelineRunRow; isNew: boolean } {
  const existing = db
    .query(
      `SELECT * FROM pipeline_runs WHERE pipeline_name = ? AND pipeline_version = ? AND config_hash = ? AND input_fingerprint = ?`,
    )
    .get(input.pipelineName, input.pipelineVersion, input.configHash, input.inputFingerprint) as
    | PipelineRunRow
    | null;
  if (existing) return { row: existing, isNew: false };
  const id = newId();
  db.query(
    `INSERT INTO pipeline_runs(id, pipeline_name, pipeline_version, prompt_version, model_name, config_hash, started_at, status, input_fingerprint)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?)`,
  ).run(id, input.pipelineName, input.pipelineVersion, input.promptVersion, input.modelName, input.configHash, now, input.inputFingerprint);
  return { row: db.query(`SELECT * FROM pipeline_runs WHERE id = ?`).get(id) as PipelineRunRow, isNew: true };
}

export function completeRun(db: Database, id: string, status: "succeeded" | "failed", errorCode: string | null, now = Date.now()): void {
  db.query(`UPDATE pipeline_runs SET status = ?, error_code = ?, completed_at = ? WHERE id = ?`).run(status, errorCode, now, id);
}

// ─── artifacts + evidence_edges ─────────────────────────────────────────────

export interface InsertArtifactInput {
  runId: string;
  artifactType: string;
  payload: unknown;
  epistemicType: string;
  extractorConfidence: number | null;
}

export function insertArtifact(db: Database, input: InsertArtifactInput, now = Date.now()): ArtifactRow {
  const id = newId();
  db.query(
    `INSERT INTO artifacts(id, run_id, artifact_type, payload_json, epistemic_type, extractor_confidence, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, input.runId, input.artifactType, JSON.stringify(input.payload), input.epistemicType, input.extractorConfidence, now);
  return db.query(`SELECT * FROM artifacts WHERE id = ?`).get(id) as ArtifactRow;
}

export function getArtifact(db: Database, id: string): ArtifactRow | null {
  return db.query(`SELECT * FROM artifacts WHERE id = ?`).get(id) as ArtifactRow | null;
}

export function getArtifactsForRun(db: Database, runId: string, artifactType?: string): ArtifactRow[] {
  if (artifactType) return db.query(`SELECT * FROM artifacts WHERE run_id = ? AND artifact_type = ?`).all(runId, artifactType) as ArtifactRow[];
  return db.query(`SELECT * FROM artifacts WHERE run_id = ?`).all(runId) as ArtifactRow[];
}

export function insertEvidenceEdge(
  db: Database,
  artifactId: string,
  sourceRevisionId: string,
  relation: string,
  locator: unknown,
  evidenceQuality: number | null,
): void {
  db.query(
    `INSERT INTO evidence_edges(artifact_id, source_revision_id, relation, locator_json, evidence_quality)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(artifact_id, source_revision_id, relation) DO NOTHING`,
  ).run(artifactId, sourceRevisionId, relation, locator == null ? null : JSON.stringify(locator), evidenceQuality);
}

export interface EvidenceView {
  sourceId: string;
  sourceType: string;
  locator: string | null;
  conversationId: string | null;
  messageId: string | null;
  role: string | null;
  occurredAt: number | null;
  revisionId: string;
  excerpt: string | null;
  relation: string;
  evidenceQuality: number | null;
}

/** Provenance for one artifact: every source revision it cites, joined back to its source. */
export function getEvidenceForArtifact(db: Database, artifactId: string): EvidenceView[] {
  return db
    .query(
      `SELECT s.id as sourceId, s.source_type as sourceType, s.stable_locator as locator,
                      s.conversation_id as conversationId, s.message_id as messageId, s.role as role,
                      s.source_timestamp as occurredAt, r.id as revisionId, r.excerpt as excerpt,
              e.relation as relation, e.evidence_quality as evidenceQuality
       FROM evidence_edges e
       JOIN source_revisions r ON r.id = e.source_revision_id
       JOIN sources s ON s.id = r.source_id
       WHERE e.artifact_id = ? AND s.deleted_at IS NULL`,
    )
    .all(artifactId) as EvidenceView[];
}

/** Count distinct source-conversation roots behind a set of artifacts — source-independence proxy. */
export function countIndependentSources(db: Database, artifactIds: string[]): number {
  if (artifactIds.length === 0) return 0;
  const placeholders = artifactIds.map(() => "?").join(",");
  const rows = db
    .query(
      `SELECT DISTINCT s.conversation_id as cid
       FROM evidence_edges e
       JOIN source_revisions r ON r.id = e.source_revision_id
       JOIN sources s ON s.id = r.source_id
       WHERE e.artifact_id IN (${placeholders})`,
    )
    .all(...artifactIds) as Array<{ cid: string | null }>;
  return new Set(rows.map((r) => r.cid ?? "")).size;
}
