import type { Database } from "bun:sqlite";
import { runReviewAction } from "./actions.ts";
import { getDemoDb } from "./demoDb.ts";
import { DEMO_CONVERSATIONS, DEMO_IDS, DEMO_NOW, ensureDemoSeeded, resetDemoDatabase } from "./demoSeed.ts";
import { ThreadkeeperError } from "./errors.ts";
import { getEvidenceForArtifact } from "./repositories/evidence.ts";

export function parseDataset(value: string | null | undefined): "live" | "demo" {
  if (value == null || value === "live") return "live";
  if (value === "demo") return "demo";
  throw new ThreadkeeperError("ROUTE_VALIDATION_FAILED", "dataset must be live or demo");
}

function db(): Database { const handle = getDemoDb(); ensureDemoSeeded(handle); return handle; }
function clamp(value: unknown, fallback = 50): number { const n = Number(value); return Number.isFinite(n) ? Math.max(1, Math.min(50, Math.floor(n))) : fallback; }
function parse(value: string): Record<string, any> { return JSON.parse(value) as Record<string, any>; }

function sourcesFor(handle: Database, artifactId: string | null) {
  if (!artifactId) return [];
  return getEvidenceForArtifact(handle, artifactId).map((item) => {
    const conversation = item.conversationId ? DEMO_CONVERSATIONS[item.conversationId] : null;
    return { ...item, conversationTitle: conversation?.title ?? null, conversationDate: conversation?.date ?? null, label: conversation?.title ? `You in ${conversation.title}` : "You in a demo conversation" };
  });
}

function cadence(handle: Database) {
  const rows = handle.query(`SELECT id, object_json, status, supersedes_claim_id supersedesClaimId FROM claims WHERE subject='Northstar' AND predicate='publishing cadence' ORDER BY created_at`).all() as Record<string, any>[];
  const value = (row: Record<string, any>) => JSON.parse(row.object_json);
  const current = rows.find((row) => row.status === "active");
  return { current: current ? value(current) : null, history: rows.filter((row) => row.status !== "active").map(value) };
}
function thread(handle: Database, id: string) {
  const row = handle.query(`SELECT id, title, summary, status, created_at createdAt, updated_at updatedAt, archived_at archivedAt FROM threads WHERE id = ?`).get(id) as Record<string, any> | null;
  return row && id === DEMO_IDS.northstar ? { ...row, cadence: cadence(handle) } : row;
}
function shapeLoop(handle: Database, row: Record<string, any>) {
  const sources = sourcesFor(handle, row.created_from_artifact_id);
  return { id: row.id, kind: "open_loop", threadId: row.thread_id, title: row.description, description: row.description, nextAction: row.next_action, status: row.status, dueAt: row.due_at, originType: row.origin_type, confidence: row.confidence, createdAt: row.created_at, updatedAt: row.updated_at, excerpt: sources[0]?.excerpt ?? null, conversation: sources[0]?.conversationId ? { id: sources[0].conversationId, title: sources[0].conversationTitle, date: sources[0].conversationDate } : null, sources };
}
function scoreConfidence(parts: Record<string, any>): number { return Math.max(0, Math.min(1, Number(parts.extraction ?? 0) * 0.6 + Number(parts.evidence_quality ?? 0) * 0.4)); }
function shapeProposal(handle: Database, row: Record<string, any>) {
  const payload = parse(row.proposed_payload_json); const confidence = parse(row.confidence_json); const sources = sourcesFor(handle, payload.artifactId ?? null);
  return { id: row.id, kind: "proposal", proposalType: row.proposal_type, targetType: row.target_type, targetId: row.target_id, operation: row.operation, payload, title: "Supersede Northstar cadence: weekly → monthly", description: "Accepting creates an active monthly cadence claim and supersedes the active weekly claim.", impact: "Makes monthly current while preserving weekly as superseded historical context.", status: row.status, confidence: scoreConfidence(confidence), confidenceComponents: confidence, risk: confidence.risk, createdAt: row.created_at, sources, excerpt: sources[0]?.excerpt ?? null };
}
function shapeConnection(handle: Database, row: Record<string, any>) {
  const sources = sourcesFor(handle, DEMO_IDS.reuseArtifact); const from = thread(handle, row.from_id); const to = thread(handle, row.to_id); const score = parse(row.score_json);
  return { id: row.id, kind: "connection", fromType: row.from_type, fromId: row.from_id, toType: row.to_type, toId: row.to_id, relationType: row.relation_type, title: "Reuse the briefing format for Northstar", description: row.explanation, summary: `${from?.title ?? "Client briefing"} → ${to?.title ?? "Northstar"}`, explanation: row.explanation, score, confidence: score.final, status: row.status, createdAt: row.created_at, sources };
}
function shapeArchaeology(handle: Database) {
  const artifact = handle.query(`SELECT * FROM artifacts WHERE id = ?`).get(DEMO_IDS.archaeologyArtifact) as Record<string, any> | null;
  if (!artifact) return null; const report = parse(artifact.payload_json); const sources = sourcesFor(handle, artifact.id);
  return { id: artifact.id, kind: "archaeology_report", title: "Northstar product launch", description: report.current_state, summary: "A four-step reconstruction from weekly kickoff to a narrower monthly restart.", status: "completed", confidence: 0.98, createdAt: artifact.created_at, nextAction: report.suggested_next_action, timeline: report.timeline, known: report.known, likelyInterpretations: report.likely_interpretations, unknowns: report.unknowns, unresolved: report.unresolved, sources };
}

export async function getDemoStatus() {
  const handle = db(); const count = (sql: string) => (handle.query(sql).get() as { n: number }).n;
  return { dataset: "demo", datasetLabel: "Product Launch demo", demoNow: DEMO_NOW, captureEnabled: false, queueDepth: 0, dirtyOldestAgeMs: null, jobsByStatus: { pending: 0, running: 0, succeeded: 1, failed: 0 }, reviewCount: count(`SELECT COUNT(*) n FROM proposals WHERE status='pending'`) + count(`SELECT COUNT(*) n FROM connections WHERE status='pending'`), proposalCount: count(`SELECT COUNT(*) n FROM proposals WHERE status='pending'`), connectionCount: count(`SELECT COUNT(*) n FROM connections WHERE status='pending'`), openLoopCount: count(`SELECT COUNT(*) n FROM open_loops WHERE status='open'`), threadCount: count(`SELECT COUNT(*) n FROM threads WHERE status!='archived'`), indexDocumentCount: count(`SELECT COUNT(*) n FROM index_documents`), lastRunAt: DEMO_NOW, lastErrorCode: null, serendipityEnabled: true, canonicalStore: "threadkeeper-demo.sqlite", isolatedFromLive: true };
}
export async function listDemoThreads(input: { status?: string; limit?: number }) { const handle = db(); const status = input.status ?? "active"; const rows = status === "all" ? handle.query(`SELECT id, title, summary, status, created_at createdAt, updated_at updatedAt, archived_at archivedAt FROM threads ORDER BY updated_at DESC LIMIT ?`).all(clamp(input.limit)) : handle.query(`SELECT id, title, summary, status, created_at createdAt, updated_at updatedAt, archived_at archivedAt FROM threads WHERE status=? ORDER BY updated_at DESC LIMIT ?`).all(status, clamp(input.limit)); return { items: (rows as Record<string, any>[]).map((row) => row.id === DEMO_IDS.northstar ? { ...row, cadence: cadence(handle) } : row) }; }
export async function getDemoThread(input: { id: string }) { const handle = db(); const row = thread(handle, input.id); if (!row) throw new ThreadkeeperError("NOT_FOUND", "demo thread not found"); const events = handle.query(`SELECT id, thread_id threadId, event_type type, title, description, occurred_at occurredAt FROM events WHERE thread_id=? ORDER BY occurred_at`).all(input.id); const loops = (handle.query(`SELECT * FROM open_loops WHERE thread_id=? ORDER BY updated_at DESC`).all(input.id) as Record<string, any>[]).map((item) => shapeLoop(handle, item)); return { ...row, events, openLoops: loops, connections: input.id === DEMO_IDS.northstar || input.id === DEMO_IDS.briefing ? (await listDemoReviews({ type: "connection", limit: 10 })).items : [], memberCount: (handle.query(`SELECT COUNT(*) n FROM thread_memberships WHERE thread_id=?`).get(input.id) as { n: number }).n }; }
export async function listDemoOpenLoops(input: { status?: string; limit?: number }) { const handle = db(); const status = input.status ?? "open"; const rows = status === "all" ? handle.query(`SELECT * FROM open_loops ORDER BY updated_at DESC LIMIT ?`).all(clamp(input.limit)) : handle.query(`SELECT * FROM open_loops WHERE status=? ORDER BY updated_at DESC LIMIT ?`).all(status, clamp(input.limit)); return { items: (rows as Record<string, any>[]).map((row) => shapeLoop(handle, row)) }; }
export async function listDemoReviews(input: { type?: string; limit?: number }) { const handle = db(); const type = input.type ?? "all"; const items: any[] = []; if (type === "proposal" || type === "all") items.push(...(handle.query(`SELECT * FROM proposals WHERE status='pending' ORDER BY created_at DESC LIMIT ?`).all(clamp(input.limit)) as Record<string, any>[]).map((row) => shapeProposal(handle, row))); if (type === "connection" || type === "all") items.push(...(handle.query(`SELECT * FROM connections WHERE status='pending' ORDER BY created_at DESC LIMIT ?`).all(clamp(input.limit)) as Record<string, any>[]).map((row) => shapeConnection(handle, row))); if (type === "archaeology") { const report = shapeArchaeology(handle); if (report) items.push(report); } return { items: items.slice(0, clamp(input.limit)) }; }

const DEMO_ACTIONS = new Set(["accept_proposal", "reject_proposal", "explore", "save_as_hypothesis", "dismiss_connection", "mark_wrong", "mark_done", "snooze"]);
export async function runDemoAction(payload: Record<string, unknown>) { const action = String(payload.action ?? payload.kind ?? ""); if (!DEMO_ACTIONS.has(action)) throw new ThreadkeeperError("ROUTE_VALIDATION_FAILED", `unsupported demo action: ${action}`); const targetId = String(payload.targetId ?? ""); if (!targetId.startsWith("tkdemo_")) throw new ThreadkeeperError("NOT_FOUND", "demo target not found"); const handle = db(); const result = runReviewAction(handle, { action, targetId, reason: typeof payload.reason === "string" ? payload.reason : null }, DEMO_NOW); return { ok: true, jobId: `tkdemo_job_${action}`, status: "succeeded", result };
}
export async function resetDemo(confirm: unknown) { if (confirm !== true && confirm !== "RESET_DEMO") throw new ThreadkeeperError("ROUTE_VALIDATION_FAILED", "demo reset requires confirmation"); const handle = getDemoDb(); resetDemoDatabase(handle); return { ok: true, dataset: "demo", resetAt: DEMO_NOW, status: await getDemoStatus() }; }
