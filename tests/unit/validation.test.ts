import "../fixtures/plugin-api-mock.ts";
import { describe, expect, test } from "bun:test";
import { sanitizeExtractionOutput, validateArchaeologyReport, validateExtractionOutput } from "../../src/validation.ts";

const VALID_EXTRACTION = {
  turn_summary: "User wants to launch a newsletter.",
  thread_candidates: [{ title: "Northstar", summary: "Newsletter launch", existing_thread_hint: null, source_message_ids: ["m1"], confidence: 0.8 }],
  events: [
    {
      type: "commitment",
      title: "Decided to launch Northstar",
      description: "",
      occurred_at: null,
      epistemic_type: "direct_fact",
      source_message_ids: ["m1"],
      confidence: 0.9,
    },
  ],
  open_loop_candidates: [{ description: "Buy the domain", next_action: null, due_at: null, origin: "direct", source_message_ids: ["m1"], confidence: 0.9 }],
  claim_candidates: [
    { subject: "user", predicate: "prefers_cadence", object: "weekly", epistemic_type: "direct_fact", temporal_status: "current", source_message_ids: ["m1"], confidence: 0.8, sensitive: false },
  ],
  closure_candidates: [],
};

describe("extraction validation", () => {
  test("valid JSON passes", () => {
    const result = validateExtractionOutput(JSON.stringify(VALID_EXTRACTION));
    expect(result.ok).toBe(true);
  });

  test("prose-wrapped JSON is recovered via the fence/brace extractor", () => {
    const wrapped = "Sure, here you go:\n```json\n" + JSON.stringify(VALID_EXTRACTION) + "\n```\nLet me know if that helps.";
    const result = validateExtractionOutput(wrapped);
    expect(result.ok).toBe(true);
  });

  test("missing source ids fail validation", () => {
    const broken = { ...VALID_EXTRACTION, events: [{ ...VALID_EXTRACTION.events[0], source_message_ids: [] }] };
    const result = validateExtractionOutput(JSON.stringify(broken));
    expect(result.ok).toBe(false);
  });

  test("unsupported enum values fail validation", () => {
    const broken = { ...VALID_EXTRACTION, events: [{ ...VALID_EXTRACTION.events[0], type: "not_a_real_type" }] };
    const result = validateExtractionOutput(JSON.stringify(broken));
    expect(result.ok).toBe(false);
  });

  test("genuinely malformed JSON fails validation with a readable error", () => {
    const result = validateExtractionOutput("{not json at all");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.length).toBeGreaterThan(0);
  });

  test("sensitive inferred claims survive validation and keep their sensitive flag", () => {
    const withSensitive = {
      ...VALID_EXTRACTION,
      claim_candidates: [{ ...VALID_EXTRACTION.claim_candidates[0], epistemic_type: "interpretation", sensitive: true }],
    };
    const result = validateExtractionOutput(JSON.stringify(withSensitive));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.claim_candidates[0]!.sensitive).toBe(true);
  });

  test("sanitize drops candidates whose source ids are not in the known set (hallucinated citations)", () => {
    const parsed = validateExtractionOutput(JSON.stringify(VALID_EXTRACTION));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const sanitized = sanitizeExtractionOutput(parsed.value, new Set(["some-other-message-id"]));
    expect(sanitized.events.length).toBe(0);
    expect(sanitized.open_loop_candidates.length).toBe(0);
    expect(sanitized.claim_candidates.length).toBe(0);
  });

  test("sanitize keeps candidates whose source ids are all known", () => {
    const parsed = validateExtractionOutput(JSON.stringify(VALID_EXTRACTION));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const sanitized = sanitizeExtractionOutput(parsed.value, new Set(["m1"]));
    expect(sanitized.events.length).toBe(1);
  });
});

describe("archaeology report validation", () => {
  const VALID_REPORT = {
    subject: "Northstar",
    current_state: "Active again after dormancy.",
    timeline: [{ date: "2026-01-08", title: "Kickoff", description: "Decided to launch.", source_ids: ["ev0"], evidence_type: "known" }],
    original_intent: "Launch a weekly newsletter.",
    decision_reasons: [],
    assumptions: [],
    scope_changes: [],
    unresolved: [],
    known: ["Domain was purchased."],
    likely_interpretations: [],
    unknowns: [],
    suggested_next_action: null,
  };

  test("valid archaeology report passes", () => {
    const result = validateArchaeologyReport(JSON.stringify(VALID_REPORT));
    expect(result.ok).toBe(true);
  });

  test("an unsupported evidence_type fails validation", () => {
    const broken = { ...VALID_REPORT, timeline: [{ ...VALID_REPORT.timeline[0], evidence_type: "definitely" }] };
    const result = validateArchaeologyReport(JSON.stringify(broken));
    expect(result.ok).toBe(false);
  });
});
