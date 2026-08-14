import type { Database } from "bun:sqlite";
import { normalizeText } from "./ids.ts";

const DAY = 24 * 60 * 60 * 1000;
export const DEMO_NOW = Date.parse("2026-08-14T12:00:00Z");
const P = "tkdemo_";
export const DEMO_SEED_VERSION_KEY = "threadkeeper_demo_seed_version";
export const DEMO_SEED_VERSION = "operator-week-v1";

export const DEMO_IDS = {
  billing: `${P}thread_marlowe_billing_fix`,
  invoice: `${P}thread_marlowe_invoice_followup`,
  verifyLoop: `${P}loop_marlowe_fix_verification`,
  shipLoop: `${P}loop_marlowe_fix_staging_ship`,
  summaryLoop: `${P}loop_marlowe_fix_summary`,
  callProposal: `${P}proposal_marlowe_call_reschedule`,
  callClaim: `${P}claim_marlowe_call_time`,
  bridgeConnection: `${P}connection_invoice_followup_billing_bridge`,
  seedRun: `${P}run_seed`,
  archaeologyArtifact: `${P}artifact_archaeology_report`,
  bugReportArtifact: `${P}artifact_bug_report`,
  verifyArtifact: `${P}artifact_fix_verification`,
  shipArtifact: `${P}artifact_fix_staging_ship`,
  summaryArtifact: `${P}artifact_fix_summary`,
  scopeArtifact: `${P}artifact_scope_expansion`,
  rescheduleArtifact: `${P}artifact_call_reschedule`,
  bridgeArtifact: `${P}artifact_invoice_bridge`,
} as const;

export const DEMO_CONVERSATIONS: Record<string, { title: string; date: number }> = {
  [`${P}conversation_bugreport`]: { title: "Marlowe billing bug report", date: Date.parse("2026-01-08T12:00:00Z") },
  [`${P}conversation_invoiceworkflow`]: { title: "Invoice follow-up workflow", date: Date.parse("2026-02-14T12:00:00Z") },
  [`${P}conversation_scope`]: { title: "Billing fix scope grows", date: Date.parse("2026-04-03T12:00:00Z") },
  [`${P}conversation_reschedule`]: { title: "Marlowe call rescheduled", date: Date.parse("2026-06-18T12:00:00Z") },
  [`${P}conversation_invoicenotes`]: { title: "Invoice follow-up notes", date: Date.parse("2026-07-08T12:00:00Z") },
  [`${P}conversation_restart`]: { title: "Billing fix verification restart", date: Date.parse("2026-08-01T12:00:00Z") },
};

type SourceDef = { key: string; title: string; excerpt: string; at: number };
const SOURCE_DEFS: SourceDef[] = [
  { key: "bugreport", title: "Marlowe billing bug report", excerpt: "Marlowe Freight is seeing duplicate line items on invoices for split shipments. I need to trace the billing path, patch it, and verify a corrected invoice. The standing Marlowe review call is Wednesday at 2:00 PM.", at: DEMO_CONVERSATIONS[`${P}conversation_bugreport`]!.date },
  { key: "invoiceworkflow", title: "Invoice follow-up workflow", excerpt: "The invoice follow-up format worked well: check three signals, explain why each matters, then give one recommended follow-up action.", at: DEMO_CONVERSATIONS[`${P}conversation_invoiceworkflow`]!.date },
  { key: "scope", title: "Billing fix scope grows", excerpt: "The split-shipment bug traces back further than expected into a related proration bug. The billing fix scope has grown, but I am not abandoning it.", at: DEMO_CONVERSATIONS[`${P}conversation_scope`]!.date },
  { key: "reschedule", title: "Marlowe call rescheduled", excerpt: "I shipped the fix to staging. The standing Marlowe review call moves from Wednesday 2:00 PM to Thursday 10:00 AM. Keep Wednesday 2:00 PM as historical context.", at: DEMO_CONVERSATIONS[`${P}conversation_reschedule`]!.date },
  { key: "invoicenotes", title: "Invoice follow-up notes", excerpt: "Marlowe's retainer invoice is overdue, and their AP contact is waiting on the billing fix. The invoice follow-up structure could apply here.", at: DEMO_CONVERSATIONS[`${P}conversation_invoicenotes`]!.date },
  { key: "restart", title: "Billing fix verification restart", excerpt: "The Marlowe billing fix is deployed to production and the customer-facing summary is drafted, but the next invoice run is still unverified. I want it confirmed by August 20, 2026, before Thursday's call.", at: DEMO_CONVERSATIONS[`${P}conversation_restart`]!.date },
];

type SeedSource = SourceDef & { sourceId: string; revisionId: string; conversationId: string };

function insertSource(db: Database, source: SourceDef): SeedSource {
  const conversationId = `${P}conversation_${source.key}`;
  const sourceId = `${P}source_${source.key}`;
  const revisionId = `${P}revision_${source.key}`;
  const messageId = `${P}message_${source.key}`;
  db.query(`INSERT INTO sources(id, source_type, stable_locator, conversation_id, message_id, role, source_timestamp, sensitivity) VALUES (?, 'conversation_message', ?, ?, ?, 'user', ?, 'normal')`).run(sourceId, messageId, conversationId, messageId, source.at);
  db.query(`INSERT INTO source_revisions(id, source_id, content_hash, captured_at, content_length, excerpt, canonical_text) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(revisionId, sourceId, `${P}hash_${source.key}`, source.at, source.excerpt.length, source.excerpt, source.excerpt);
  return { ...source, sourceId, revisionId, conversationId };
}

function insertArtifact(db: Database, id: string, type: string, payload: unknown, createdAt = DEMO_NOW): void {
  db.query(`INSERT INTO artifacts(id, run_id, artifact_type, payload_json, epistemic_type, extractor_confidence, created_at) VALUES (?, ?, ?, ?, 'interpretation', 0.98, ?)`).run(id, DEMO_IDS.seedRun, type, JSON.stringify(payload), createdAt);
}

function addEvidence(db: Database, artifactId: string, revisionId: string): void {
  db.query(`INSERT INTO evidence_edges(artifact_id, source_revision_id, relation, evidence_quality) VALUES (?, ?, 'supports', 0.98)`).run(artifactId, revisionId);
}

export function resetDemoDatabase(db: Database): void {
  db.transaction(() => {
    for (const table of ["audit_events", "index_documents", "jobs", "feedback", "connections", "proposals", "claims", "open_loops", "events", "thread_memberships", "threads", "evidence_edges", "artifacts", "pipeline_runs", "source_revisions", "sources", "dirty_conversations", "conversation_cursors", "tombstones"]) db.exec(`DELETE FROM ${table}`);
    seedDemoDatabase(db);
  })();
}

export function seedDemoDatabase(db: Database): void {
  const sourceList = SOURCE_DEFS.map((item) => insertSource(db, item));
  const src = new Map(sourceList.map((item) => [item.key, item]));
  db.query(`INSERT INTO pipeline_runs(id, pipeline_name, pipeline_version, prompt_version, model_name, config_hash, started_at, completed_at, status, input_fingerprint) VALUES (?, 'demo-seed', '1', 'deterministic', 'demo', 'threadkeeper-demo-config-v1', ?, ?, 'succeeded', ?)`).run(DEMO_IDS.seedRun, DEMO_NOW, DEMO_NOW, `${P}seed_v1`);

  db.query(`INSERT INTO threads(id, title, normalized_title, summary, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?), (?, ?, ?, ?, 'active', ?, ?)`).run(
    DEMO_IDS.billing, "Marlowe billing fix", normalizeText("Marlowe billing fix"), "A split-shipment billing bug that grew in scope, shipped to staging and then production, and still needs invoice verification before Thursday's call.", src.get("bugreport")!.at, DEMO_NOW,
    DEMO_IDS.invoice, "Marlowe invoice follow-up", normalizeText("Marlowe invoice follow-up"), "A reusable overdue-invoice workflow applied to Marlowe's retainer invoice, which may be waiting on the billing fix.", src.get("invoiceworkflow")!.at, src.get("invoicenotes")!.at,
  );
  for (const [threadId, key] of [[DEMO_IDS.billing, "bugreport"], [DEMO_IDS.billing, "scope"], [DEMO_IDS.billing, "reschedule"], [DEMO_IDS.billing, "restart"], [DEMO_IDS.invoice, "invoiceworkflow"], [DEMO_IDS.invoice, "invoicenotes"]] as const) {
    db.query(`INSERT INTO thread_memberships(thread_id, object_type, object_id, membership_type, confidence) VALUES (?, 'conversation', ?, 'source', 0.98)`).run(threadId, src.get(key)!.conversationId);
  }

  for (const [id, type] of [[DEMO_IDS.bugReportArtifact, "demo_bugreport"], [DEMO_IDS.verifyArtifact, "demo_verify"], [DEMO_IDS.shipArtifact, "demo_ship"], [DEMO_IDS.summaryArtifact, "demo_summary"], [DEMO_IDS.scopeArtifact, "demo_scope"], [DEMO_IDS.rescheduleArtifact, "demo_reschedule"], [DEMO_IDS.bridgeArtifact, "demo_bridge"]] as const) insertArtifact(db, id, type, { demo: true });
  addEvidence(db, DEMO_IDS.bugReportArtifact, src.get("bugreport")!.revisionId);
  addEvidence(db, DEMO_IDS.verifyArtifact, src.get("restart")!.revisionId);
  addEvidence(db, DEMO_IDS.shipArtifact, src.get("reschedule")!.revisionId);
  addEvidence(db, DEMO_IDS.summaryArtifact, src.get("restart")!.revisionId);
  addEvidence(db, DEMO_IDS.scopeArtifact, src.get("scope")!.revisionId);
  addEvidence(db, DEMO_IDS.rescheduleArtifact, src.get("reschedule")!.revisionId);
  addEvidence(db, DEMO_IDS.bridgeArtifact, src.get("invoiceworkflow")!.revisionId);
  addEvidence(db, DEMO_IDS.bridgeArtifact, src.get("invoicenotes")!.revisionId);

  db.query(`INSERT INTO open_loops(id, thread_id, description, next_action, status, due_at, origin_type, confidence, created_from_artifact_id, created_at, updated_at) VALUES (?, ?, ?, ?, 'open', ?, 'direct', 0.99, ?, ?, ?), (?, ?, ?, ?, 'done', NULL, 'direct', 0.99, ?, ?, ?), (?, ?, ?, ?, 'done', NULL, 'direct', 0.99, ?, ?, ?)`).run(
    DEMO_IDS.verifyLoop, DEMO_IDS.billing, "Verify the production billing fix against Marlowe's next invoice run", "Confirm the invoice run before Thursday, August 20, 2026", Date.parse("2026-08-20T00:00:00Z"), DEMO_IDS.verifyArtifact, DEMO_NOW, DEMO_NOW,
    DEMO_IDS.shipLoop, DEMO_IDS.billing, "Ship the billing fix to staging", "Staging deploy completed", DEMO_IDS.shipArtifact, DEMO_NOW - 2 * DAY, DEMO_NOW - 2 * DAY,
    DEMO_IDS.summaryLoop, DEMO_IDS.billing, "Draft the customer-facing fix summary for Marlowe", "Summary drafted and shared internally", DEMO_IDS.summaryArtifact, DEMO_NOW - DAY, DEMO_NOW - DAY,
  );

  const events = [
    [`${P}event_1`, "Marlowe billing fix starts as a split-shipment bug report", "The original report was duplicate line items on split-shipment invoices.", src.get("bugreport")!.at, DEMO_IDS.verifyArtifact],
    [`${P}event_2`, "Billing fix scope expands to a proration bug", "A related proration bug when a shipment splits mid-cycle makes the fix scope larger.", src.get("scope")!.at, DEMO_IDS.scopeArtifact],
    [`${P}event_3`, "Marlowe call time changes from Wednesday to Thursday", "Thursday 10:00 AM becomes the current call time; Wednesday 2:00 PM remains historical context.", src.get("reschedule")!.at, DEMO_IDS.rescheduleArtifact],
    [`${P}event_4`, "Billing fix verification restarts with a deadline", "Production deploy is complete and the summary is drafted; invoice verification is due August 20, 2026.", src.get("restart")!.at, DEMO_IDS.verifyArtifact],
  ] as const;
  for (const [id, title, description, occurredAt, artifactId] of events) db.query(`INSERT INTO events(id, thread_id, event_type, title, description, occurred_at, status, created_from_artifact_id, created_at) VALUES (?, ?, 'milestone', ?, ?, ?, 'accepted', ?, ?)`).run(id, DEMO_IDS.billing, title, description, occurredAt, artifactId, occurredAt);

  db.query(`INSERT INTO claims(id, subject, predicate, object_json, epistemic_type, valid_from, valid_to, status, supersedes_claim_id, created_from_artifact_id, created_at, updated_at) VALUES (?, 'Marlowe billing review call', 'call time', ?, 'direct_fact', ?, NULL, 'active', NULL, ?, ?, ?)`).run(
    DEMO_IDS.callClaim, JSON.stringify("Wednesday 2:00 PM"), src.get("bugreport")!.at, DEMO_IDS.bugReportArtifact, src.get("bugreport")!.at, src.get("bugreport")!.at,
  );
  db.query(`INSERT INTO proposals(id, proposal_type, target_type, target_id, operation, proposed_payload_json, status, fingerprint, confidence_json, created_by_run_id, created_at) VALUES (?, 'supersede_claim', 'claim', ?, 'update_call_time', ?, 'pending', ?, ?, ?, ?)`).run(
    DEMO_IDS.callProposal, DEMO_IDS.callClaim,
    JSON.stringify({ description: "Move the Marlowe billing review call from Wednesday 2:00 PM to Thursday 10:00 AM", subject: "Marlowe billing review call", predicate: "call time", object: "Thursday 10:00 AM", epistemicType: "direct_fact", previousCallTime: "Wednesday 2:00 PM", nextCallTime: "Thursday 10:00 AM", supersedesClaimId: DEMO_IDS.callClaim, artifactId: DEMO_IDS.rescheduleArtifact }),
    `${P}fingerprint_call_reschedule_v2`, JSON.stringify({ extraction: 0.98, evidence_quality: 0.98, source_independence: 1, recency: 0.95, user_confirmation: 0.8, contradiction_penalty: 0, risk: "low" }), DEMO_IDS.seedRun, src.get("reschedule")!.at,
  );
  db.query(`INSERT INTO connections(id, from_type, from_id, to_type, to_id, relation_type, explanation, score_json, status, fingerprint, created_by_run_id, created_at) VALUES (?, 'thread', ?, 'thread', ?, 'bridge', ?, ?, 'pending', ?, ?, ?)`).run(
    DEMO_IDS.bridgeConnection, DEMO_IDS.invoice, DEMO_IDS.billing,
    "The Marlowe billing fix may be why Marlowe's retainer invoice is overdue: their AP contact said payment is waiting on the fix landing in production.",
    JSON.stringify({ relevance: 0.97, novelty: 0.84, specificity: 0.95, actionability: 0.96, evidence_strength: 0.98, source_independence: 1, recurrence: 0.8, timing: 0.9, genericity_penalty: 0, sensitivity_penalty: 0, repetition_penalty: 0, final: 0.94 }), `${P}fingerprint_bridge_v1`, DEMO_IDS.seedRun, src.get("invoicenotes")!.at,
  );

  const report = {
    subject: "Marlowe billing fix",
    current_state: "The Marlowe billing fix is active again. The fix shipped to staging, the customer-facing summary is drafted, and production verification is still open with an August 20, 2026 deadline before Thursday's call.",
    timeline: events.map(([id, title, description, occurredAt]) => ({ date: new Date(occurredAt).toISOString().slice(0, 10), title, description, source_ids: [id], evidence_type: "known" })),
    known: ["The fix shipped to staging.", "The customer-facing summary is drafted.", "The current call time is Thursday 10:00 AM."],
    likely_interpretations: ["The overdue Marlowe invoice may be waiting on the billing fix reaching production."],
    unknowns: ["Whether the next invoice run will confirm the fix in production before August 20."],
    unresolved: ["Verify the production billing fix against Marlowe's next invoice run by August 20, 2026."],
    suggested_next_action: "Verify the production fix, then confirm with Marlowe that the overdue invoice can be released.",
  };
  insertArtifact(db, DEMO_IDS.archaeologyArtifact, "archaeology_report", report);
  for (const key of ["bugreport", "scope", "reschedule", "restart"] as const) addEvidence(db, DEMO_IDS.archaeologyArtifact, src.get(key)!.revisionId);

  db.query(`INSERT INTO index_documents(document_id, owner_type, owner_id, content_hash, indexed_at) VALUES (?, 'thread', ?, ?, ?), (?, 'thread', ?, ?, ?)`).run(
    `${P}index_billing`, DEMO_IDS.billing, `${P}hash_index_billing`, DEMO_NOW,
    `${P}index_invoice`, DEMO_IDS.invoice, `${P}hash_index_invoice`, DEMO_NOW,
  );
  db.query(`INSERT INTO schema_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(DEMO_SEED_VERSION_KEY, DEMO_SEED_VERSION);
}

export function ensureDemoSeeded(db: Database): void {
  const thread = db.query(`SELECT COUNT(*) as n FROM threads WHERE id = ?`).get(DEMO_IDS.billing) as { n: number };
  const version = db.query(`SELECT value FROM schema_meta WHERE key = ?`).get(DEMO_SEED_VERSION_KEY) as { value: string } | null;
  if (thread.n === 0 || version?.value !== DEMO_SEED_VERSION) resetDemoDatabase(db);
}
