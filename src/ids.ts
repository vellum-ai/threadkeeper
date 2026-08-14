import { createHash } from "node:crypto";

export function newId(): string {
  return crypto.randomUUID();
}

/** Recursively sort object keys and drop `undefined` so equal payloads always canonicalize identically. */
function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries) out[k] = sortValue(v);
    return out;
  }
  return value;
}

/** Deterministic JSON serialization: sorted keys, no whitespace. Same logical payload -> same string. */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

/** sha-256 hex digest of the canonicalized payload. Used for proposal/connection/pipeline-run fingerprints. */
export function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

export function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Lowercase, collapse whitespace, strip punctuation noise — for lexical thread/claim matching, not display. */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Jaccard similarity over normalized-token sets. Cheap deterministic lexical proxy — no embeddings. */
export function lexicalSimilarity(a: string, b: string): number {
  const ta = new Set(normalizeText(a).split(" ").filter(Boolean));
  const tb = new Set(normalizeText(b).split(" ").filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersection = 0;
  for (const token of ta) if (tb.has(token)) intersection++;
  const union = ta.size + tb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
