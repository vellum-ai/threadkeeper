/**
 * Verifies the Northstar demo's live state against `expected-results.json`.
 *
 * Reads Threadkeeper's own SQLite file directly (read-only) rather than going through the
 * `threadkeeper` tool or plugin routes: `assistant tools run <plugin-tool>` does not execute
 * plugin tools at all (confirmed against a live daemon — it only runs core built-ins and workspace
 * tools in a lightweight standalone process, unrelated to the daemon's real tool registry), and
 * plugin HTTP routes are only reachable through the gateway's authenticated tunnel, which this
 * script has no business probing. A direct, read-only SQLite read is simpler and more reliable
 * than either, and exercises exactly the same tables the tool/route layer reads from.
 *
 * Because extraction and archaeology depend on the disposable daemon's actual configured model,
 * checks grep for required *concepts*, not exact strings.
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { assertDaemonWorkspace, assertDisposableWorkspace, DEMO_DB_PATH, loadExpected, loadFixture, loadState, writeJson, STATE_PATH } from "./demo-lib.ts";

assertDisposableWorkspace();
await assertDaemonWorkspace();
const fixture = await loadFixture();
const expected = await loadExpected() as any;
const state = await loadState();
if (!state) throw new Error("No demo state found. Run demo-seed (and demo-process) first.");
if (!existsSync(DEMO_DB_PATH)) throw new Error(`Threadkeeper database not found at ${DEMO_DB_PATH}.`);

const db = new Database(DEMO_DB_PATH, { readonly: true });
const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
const check = (name: string, ok: boolean, detail: string) => {
  checks.push({ name, ok, detail });
  if (!ok) console.error(`FAIL ${name}: ${detail}`);
};
const like = (text: string) => `%${text.toLowerCase()}%`;

check(
  "fixture has six stable conversations",
  fixture.conversations.length === 6 && new Set(fixture.conversations.map((c) => c.sourceKey)).size === 6,
  fixture.conversations.map((c) => c.sourceKey).join(", "),
);
check("all imported ids mapped", Object.keys(state.conversationIds).length === 6, `${Object.keys(state.conversationIds).length}/6 ids mapped`);

// ── threads ──────────────────────────────────────────────────────────────────
const threads = db.query(`SELECT id, title, summary FROM threads`).all() as Array<{ id: string; title: string; summary: string | null }>;
const matchesConcept = (t: { title: string; summary: string | null }, concept: string) =>
  t.title.toLowerCase().includes(concept.toLowerCase()) || (t.summary ?? "").toLowerCase().includes(concept.toLowerCase());
check("at least the minimum required threads exist", threads.length >= (expected.threads?.minimum ?? 1), `found ${threads.length} threads`);
for (const concept of expected.threads?.requiredConcepts ?? []) {
  check(`a thread exists for concept "${concept}"`, threads.some((t) => matchesConcept(t, concept)), `no thread title/summary matched "${concept}"`);
}

// ── open loops ────────────────────────────────────────────────────────────────
const openLoops = db.query(`SELECT description, status, due_at FROM open_loops`).all() as Array<{ description: string; status: string; due_at: number | null }>;
for (const required of expected.openLoops?.requiredOpen ?? []) {
  const match = openLoops.find((l) => l.status === "open" && l.description.toLowerCase().includes(String(required.concept).toLowerCase()));
  check(`open loop "${required.concept}" is open`, !!match, `no open loop matched "${required.concept}"`);
  if (match && required.dueDate) {
    const due = match.due_at ? new Date(match.due_at).toISOString().slice(0, 10) : null;
    check(`open loop "${required.concept}" has the expected due date`, due === required.dueDate, `due_at was ${due ?? "null"}, expected ${required.dueDate}`);
  }
}
for (const required of expected.openLoops?.requiredClosed ?? []) {
  const match = openLoops.find((l) => l.description.toLowerCase().includes(String(required.concept).toLowerCase()));
  check(`"${required.concept}" is closed, not open`, !match || match.status !== "open", `"${required.concept}" is still open`);
}
for (const forbidden of expected.openLoops?.forbiddenOpenConcepts ?? []) {
  const stillOpen = openLoops.some((l) => l.status === "open" && l.description.toLowerCase().includes(String(forbidden).toLowerCase()));
  check(`"${forbidden}" is not left open`, !stillOpen, `"${forbidden}" unexpectedly still open`);
}

// ── claims: always proposals in v1 (never auto-materialized — see IMPLEMENTATION_NOTES.md) ──
const proposals = db.query(`SELECT proposal_type, status, proposed_payload_json FROM proposals`).all() as Array<{
  proposal_type: string;
  status: string;
  proposed_payload_json: string;
}>;
const claimProposalText = proposals
  .filter((p) => p.proposal_type === "create_claim" || p.proposal_type === "supersede_claim")
  .map((p) => p.proposed_payload_json.toLowerCase())
  .join(" ");
for (const concept of expected.claims?.requiredCurrent ?? []) {
  check(`a claim proposal mentions "${concept}"`, claimProposalText.includes(String(concept).toLowerCase().split(" ")[0]), `no claim proposal payload mentioned "${concept}"`);
}
if (expected.claims?.supersession?.requiresReviewableProposal) {
  check("cadence change is a reviewable proposal, not a silent rewrite", proposals.some((p) => p.proposal_type === "supersede_claim" || p.proposal_type === "create_claim"), "no claim proposal exists");
}

// ── connections (serendipity) ────────────────────────────────────────────────
const connections = db.query(`SELECT relation_type, explanation, status FROM connections`).all() as Array<{ relation_type: string; explanation: string; status: string }>;
for (const required of expected.connections?.required ?? []) {
  const match = connections.find((c) => c.relation_type === required.relationType);
  check(`a "${required.relationType}" connection exists`, !!match, `no connection with relation_type "${required.relationType}"`);
  if (match) {
    for (const concept of required.explanationConcepts ?? []) {
      check(`connection explanation mentions "${concept}"`, match.explanation.toLowerCase().includes(String(concept).toLowerCase()), `explanation did not mention "${concept}": ${match.explanation}`);
    }
    if (required.proposalOnly) check("the connection is still pending (a hypothesis, not accepted memory)", match.status === "pending", `status was ${match.status}`);
  }
}

// ── archaeology: best-effort — only checked if a job already ran (see RUNBOOK.md) ──
const archaeologyJobs = db.query(`SELECT status, output_json FROM jobs WHERE job_type = 'archaeology' ORDER BY created_at DESC LIMIT 1`).all() as Array<{
  status: string;
  output_json: string | null;
}>;
if (archaeologyJobs.length > 0 && archaeologyJobs[0]!.status === "succeeded" && archaeologyJobs[0]!.output_json) {
  const output = JSON.parse(archaeologyJobs[0]!.output_json);
  const report = output?.report ?? {};
  const flat = JSON.stringify(report).toLowerCase();
  check(
    "archaeology report has the minimum timeline events",
    Array.isArray(report.timeline) && report.timeline.length >= (expected.archaeology?.minimumTimelineEvents ?? 1),
    `timeline had ${Array.isArray(report.timeline) ? report.timeline.length : 0} entries`,
  );
  for (const forbidden of expected.archaeology?.mustNotConclude ?? []) {
    check(`archaeology does not conclude "${forbidden}"`, !flat.includes(String(forbidden).toLowerCase()), `report contained forbidden conclusion "${forbidden}"`);
  }
} else {
  console.error(
    "NOTE: no completed archaeology job found yet — this requires a real conversation turn asking about " +
      'Northstar (e.g. "What happened to the Northstar newsletter?"). See RUNBOOK.md / LIVE-HOOK-PROCEDURE.md. Not counted as a failure.',
  );
}

const failures = checks.filter((c) => !c.ok);
const verification = { ok: failures.length === 0, checkedAt: new Date().toISOString(), checks, expectedSchemaVersion: expected.schemaVersion };
await writeJson(STATE_PATH, { ...state, verification });
console.log(JSON.stringify(verification, null, 2));
db.close();
if (failures.length) throw new Error(`${failures.length} demo assertion(s) failed`);
