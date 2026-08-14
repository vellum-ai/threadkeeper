import type { Database } from "bun:sqlite";
import { normalizeText } from "./ids.ts";

const DAY = 24 * 60 * 60 * 1000;
export const DEMO_NOW = Date.parse("2026-08-13T12:00:00Z");
const P = "tkdemo_";

export const DEMO_IDS = {
  northstar: `${P}thread_northstar_product_launch`,
  briefing: `${P}thread_client_briefing_workflow`,
  landingLoop: `${P}loop_northstar_landing_page`,
  domainLoop: `${P}loop_northstar_domain_purchase`,
  issueLoop: `${P}loop_northstar_issue_zero`,
  cadenceProposal: `${P}proposal_northstar_cadence_update`,
  weeklyCadenceClaim: `${P}claim_northstar_weekly_cadence`,
  reuseConnection: `${P}connection_briefing_reuse_northstar`,
  seedRun: `${P}run_seed`,
  archaeologyArtifact: `${P}artifact_archaeology_report`,
  kickoffArtifact: `${P}artifact_kickoff`,
  landingArtifact: `${P}artifact_landing_page`,
  domainArtifact: `${P}artifact_domain_purchase`,
  issueArtifact: `${P}artifact_issue_zero`,
  scopeArtifact: `${P}artifact_scope_expansion`,
  cadenceArtifact: `${P}artifact_cadence_update`,
  reuseArtifact: `${P}artifact_reuse_connection`,
} as const;

export const DEMO_CONVERSATIONS: Record<string, { title: string; date: number }> = {
  [`${P}conversation_kickoff`]: { title: "Northstar newsletter kickoff", date: Date.parse("2026-01-08T12:00:00Z") },
  [`${P}conversation_briefing`]: { title: "Client briefing workflow", date: Date.parse("2026-02-14T12:00:00Z") },
  [`${P}conversation_scope`]: { title: "Northstar scope expansion", date: Date.parse("2026-04-03T12:00:00Z") },
  [`${P}conversation_cadence`]: { title: "Northstar cadence correction", date: Date.parse("2026-06-18T12:00:00Z") },
  [`${P}conversation_research`]: { title: "Research notes for actionable analysis", date: Date.parse("2026-07-08T12:00:00Z") },
  [`${P}conversation_restart`]: { title: "Northstar restart", date: Date.parse("2026-08-01T12:00:00Z") },
};

type SourceDef = { key: string; title: string; excerpt: string; at: number };
const SOURCE_DEFS: SourceDef[] = [
  { key: "kickoff", title: "Northstar newsletter kickoff", excerpt: "I want to launch a weekly newsletter called Northstar. I still need to buy the domain, publish a landing page, and draft issue zero.", at: DEMO_CONVERSATIONS[`${P}conversation_kickoff`]!.date },
  { key: "briefing", title: "Client briefing workflow", excerpt: "The client briefing format worked well: select five important developments, explain why each matters, then give one recommended action.", at: DEMO_CONVERSATIONS[`${P}conversation_briefing`]!.date },
  { key: "scope", title: "Northstar scope expansion", excerpt: "Northstar could expand beyond a newsletter into interviews, a podcast, and a research database. The scope has become too large to launch right now.", at: DEMO_CONVERSATIONS[`${P}conversation_scope`]!.date },
  { key: "cadence", title: "Northstar cadence correction", excerpt: "Actually, monthly is better than weekly. Weekly was too much. Keep weekly as historical context, but the current cadence should be monthly.", at: DEMO_CONVERSATIONS[`${P}conversation_cadence`]!.date },
  { key: "research", title: "Research notes for actionable analysis", excerpt: "The client briefing structure of five developments, why they matter, and one action could be reused for a newsletter issue.", at: DEMO_CONVERSATIONS[`${P}conversation_research`]!.date },
  { key: "restart", title: "Northstar restart", excerpt: "I am restarting Northstar. Issue zero is drafted, but the landing page is still unpublished. I want to publish the page by August 20, 2026.", at: DEMO_CONVERSATIONS[`${P}conversation_restart`]!.date },
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
    DEMO_IDS.northstar, "Northstar product launch", normalizeText("Northstar product launch"), "A focused newsletter launch that expanded, narrowed to a monthly cadence, and restarted with one launch task still open.", src.get("kickoff")!.at, DEMO_NOW,
    DEMO_IDS.briefing, "Client briefing workflow", normalizeText("Client briefing workflow"), "A reusable format: five developments, why each matters, and one recommended action.", src.get("briefing")!.at, src.get("research")!.at,
  );
  for (const [threadId, key] of [[DEMO_IDS.northstar, "kickoff"], [DEMO_IDS.northstar, "scope"], [DEMO_IDS.northstar, "cadence"], [DEMO_IDS.northstar, "restart"], [DEMO_IDS.briefing, "briefing"], [DEMO_IDS.briefing, "research"]] as const) {
    db.query(`INSERT INTO thread_memberships(thread_id, object_type, object_id, membership_type, confidence) VALUES (?, 'conversation', ?, 'source', 0.98)`).run(threadId, src.get(key)!.conversationId);
  }

  for (const [id, type] of [[DEMO_IDS.kickoffArtifact, "demo_kickoff"], [DEMO_IDS.landingArtifact, "demo_landing"], [DEMO_IDS.domainArtifact, "demo_domain"], [DEMO_IDS.issueArtifact, "demo_issue"], [DEMO_IDS.scopeArtifact, "demo_scope"], [DEMO_IDS.cadenceArtifact, "demo_cadence"], [DEMO_IDS.reuseArtifact, "demo_reuse"]] as const) insertArtifact(db, id, type, { demo: true });
  addEvidence(db, DEMO_IDS.kickoffArtifact, src.get("kickoff")!.revisionId);
  addEvidence(db, DEMO_IDS.landingArtifact, src.get("restart")!.revisionId);
  addEvidence(db, DEMO_IDS.domainArtifact, src.get("cadence")!.revisionId);
  addEvidence(db, DEMO_IDS.issueArtifact, src.get("restart")!.revisionId);
  addEvidence(db, DEMO_IDS.scopeArtifact, src.get("scope")!.revisionId);
  addEvidence(db, DEMO_IDS.cadenceArtifact, src.get("cadence")!.revisionId);
  addEvidence(db, DEMO_IDS.reuseArtifact, src.get("briefing")!.revisionId);
  addEvidence(db, DEMO_IDS.reuseArtifact, src.get("research")!.revisionId);

  db.query(`INSERT INTO open_loops(id, thread_id, description, next_action, status, due_at, origin_type, confidence, created_from_artifact_id, created_at, updated_at) VALUES (?, ?, ?, ?, 'open', ?, 'direct', 0.99, ?, ?, ?), (?, ?, ?, ?, 'done', NULL, 'direct', 0.99, ?, ?, ?), (?, ?, ?, ?, 'done', NULL, 'direct', 0.99, ?, ?, ?)`).run(
    DEMO_IDS.landingLoop, DEMO_IDS.northstar, "Publish the Northstar landing page", "Publish the landing page by August 20, 2026", Date.parse("2026-08-20T00:00:00Z"), DEMO_IDS.landingArtifact, DEMO_NOW, DEMO_NOW,
    DEMO_IDS.domainLoop, DEMO_IDS.northstar, "Buy the Northstar domain", "Domain purchase completed", DEMO_IDS.domainArtifact, DEMO_NOW - 2 * DAY, DEMO_NOW - 2 * DAY,
    DEMO_IDS.issueLoop, DEMO_IDS.northstar, "Draft issue zero", "First draft completed", DEMO_IDS.issueArtifact, DEMO_NOW - DAY, DEMO_NOW - DAY,
  );

  const events = [
    [`${P}event_1`, "Northstar starts as a weekly newsletter", "The original intent was a focused weekly publication.", src.get("kickoff")!.at, DEMO_IDS.landingArtifact],
    [`${P}event_2`, "Scope expands beyond the launch", "Interviews, a podcast, and a research database make the project too broad.", src.get("scope")!.at, DEMO_IDS.scopeArtifact],
    [`${P}event_3`, "Cadence changes from weekly to monthly", "Monthly becomes current; weekly remains historical context.", src.get("cadence")!.at, DEMO_IDS.cadenceArtifact],
    [`${P}event_4`, "Northstar restarts with a deadline", "Issue zero is drafted and the landing page is due August 20, 2026.", src.get("restart")!.at, DEMO_IDS.landingArtifact],
  ] as const;
  for (const [id, title, description, occurredAt, artifactId] of events) db.query(`INSERT INTO events(id, thread_id, event_type, title, description, occurred_at, status, created_from_artifact_id, created_at) VALUES (?, ?, 'milestone', ?, ?, ?, 'accepted', ?, ?)`).run(id, DEMO_IDS.northstar, title, description, occurredAt, artifactId, occurredAt);

  db.query(`INSERT INTO claims(id, subject, predicate, object_json, epistemic_type, valid_from, valid_to, status, supersedes_claim_id, created_from_artifact_id, created_at, updated_at) VALUES (?, 'Northstar', 'publishing cadence', ?, 'direct_fact', ?, NULL, 'active', NULL, ?, ?, ?)`).run(
    DEMO_IDS.weeklyCadenceClaim, JSON.stringify("weekly"), src.get("kickoff")!.at, DEMO_IDS.kickoffArtifact, src.get("kickoff")!.at, src.get("kickoff")!.at,
  );
  db.query(`INSERT INTO proposals(id, proposal_type, target_type, target_id, operation, proposed_payload_json, status, fingerprint, confidence_json, created_by_run_id, created_at) VALUES (?, 'supersede_claim', 'claim', ?, 'update_cadence', ?, 'pending', ?, ?, ?, ?)`).run(
    DEMO_IDS.cadenceProposal, DEMO_IDS.weeklyCadenceClaim,
    JSON.stringify({ description: "Update Northstar cadence from weekly to monthly", subject: "Northstar", predicate: "publishing cadence", object: "monthly", epistemicType: "direct_fact", previousCadence: "weekly", nextCadence: "monthly", supersedesClaimId: DEMO_IDS.weeklyCadenceClaim, artifactId: DEMO_IDS.cadenceArtifact }),
    `${P}fingerprint_cadence_v2`, JSON.stringify({ extraction: 0.98, evidence_quality: 0.98, source_independence: 1, recency: 0.95, user_confirmation: 0.8, contradiction_penalty: 0, risk: "low" }), DEMO_IDS.seedRun, src.get("cadence")!.at,
  );
  db.query(`INSERT INTO connections(id, from_type, from_id, to_type, to_id, relation_type, explanation, score_json, status, fingerprint, created_by_run_id, created_at) VALUES (?, 'thread', ?, 'thread', ?, 'reuse', ?, ?, 'pending', ?, ?, ?)`).run(
    DEMO_IDS.reuseConnection, DEMO_IDS.briefing, DEMO_IDS.northstar,
    "Reuse the client briefing structure for Northstar: five developments, why each matters, and one recommended action.",
    JSON.stringify({ relevance: 0.97, novelty: 0.84, specificity: 0.95, actionability: 0.96, evidence_strength: 0.98, source_independence: 1, recurrence: 0.8, timing: 0.9, genericity_penalty: 0, sensitivity_penalty: 0, repetition_penalty: 0, final: 0.94 }), `${P}fingerprint_reuse_v1`, DEMO_IDS.seedRun, src.get("research")!.at,
  );

  const report = {
    subject: "Northstar product launch",
    current_state: "Northstar is active again. Issue zero is drafted, the domain is purchased, and the landing page is still unpublished with an August 20, 2026 deadline.",
    timeline: events.map(([id, title, description, occurredAt]) => ({ date: new Date(occurredAt).toISOString().slice(0, 10), title, description, source_ids: [id], evidence_type: "known" })),
    known: ["Issue zero is drafted.", "The domain is purchased.", "The current cadence is monthly."],
    likely_interpretations: ["Monthly cadence is a deliberate response to the workload of weekly publishing."],
    unknowns: ["Whether the landing page will meet the August 20 deadline."],
    unresolved: ["Publish the landing page by August 20, 2026."],
    suggested_next_action: "Publish the landing page, then use the briefing format to finalize issue zero.",
  };
  insertArtifact(db, DEMO_IDS.archaeologyArtifact, "archaeology_report", report);
  for (const key of ["kickoff", "scope", "cadence", "restart"] as const) addEvidence(db, DEMO_IDS.archaeologyArtifact, src.get(key)!.revisionId);

  db.query(`INSERT INTO index_documents(document_id, owner_type, owner_id, content_hash, indexed_at) VALUES (?, 'thread', ?, ?, ?), (?, 'thread', ?, ?, ?)`).run(
    `${P}index_northstar`, DEMO_IDS.northstar, `${P}hash_index_northstar`, DEMO_NOW,
    `${P}index_briefing`, DEMO_IDS.briefing, `${P}hash_index_briefing`, DEMO_NOW,
  );
}

export function ensureDemoSeeded(db: Database): void {
  const row = db.query(`SELECT COUNT(*) as n FROM threads WHERE id = ?`).get(DEMO_IDS.northstar) as { n: number };
  if (row.n === 0) resetDemoDatabase(db);
}
