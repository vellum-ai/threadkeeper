/** Shared provenance formatting for every API surface. Internal ids remain available to the core,
 * while display enrichment adds conversation context without making host metadata canonical. */
import { listConversations } from "@vellumai/plugin-api";
import { getDb } from "./db.ts";
import { getArtifact, getEvidenceForArtifact } from "./repositories/evidence.ts";

export interface ProvenanceItem {
  sourceId: string;
  sourceType: string;
  locator: string | null;
  revisionId: string;
  conversationId: string | null;
  messageId: string | null;
  role: string | null;
  occurredAt: number | null;
  excerpt: string | null;
  relation: string;
}

export interface DisplayProvenanceItem extends ProvenanceItem {
  conversationTitle: string | null;
  conversationDate: number | null;
  label: string;
}

export function provenanceForArtifact(artifactId: string): ProvenanceItem[] {
  const db = getDb();
  return getEvidenceForArtifact(db, artifactId).map((view) => ({
    sourceId: view.sourceId,
    sourceType: view.sourceType,
    locator: view.locator,
    revisionId: view.revisionId,
    conversationId: view.conversationId,
    messageId: view.messageId,
    role: view.role,
    occurredAt: view.occurredAt,
    excerpt: view.excerpt,
    relation: view.relation,
  }));
}

/** Provenance for an accepted projection row that points back to the artifact that created it. */
export function provenanceForCreatedFromArtifact(createdFromArtifactId: string | null): ProvenanceItem[] {
  if (!createdFromArtifactId) return [];
  const db = getDb();
  const artifact = getArtifact(db, createdFromArtifactId);
  if (!artifact) return [];
  return provenanceForArtifact(artifact.id);
}

/** Add host conversation titles/dates for display. The host list call is bounded and cached briefly so
 * a page of cards does not trigger one metadata lookup per source. Failure remains non-fatal. */
type ConversationMetadata = { id: string; title: string | null; createdAt: number };
let conversationSnapshot: { expiresAt: number; rows: Map<string, ConversationMetadata> } | null = null;
let conversationSnapshotPromise: Promise<Map<string, ConversationMetadata>> | null = null;

async function conversationMetadata(): Promise<Map<string, ConversationMetadata>> {
  const now = Date.now();
  if (conversationSnapshot && conversationSnapshot.expiresAt > now) return conversationSnapshot.rows;
  if (conversationSnapshotPromise) return conversationSnapshotPromise;
  conversationSnapshotPromise = (async () => {
    const rows = new Map<string, ConversationMetadata>();
    try {
      const pageSize = 100;
      for (let offset = 0; offset < 1000; offset += pageSize) {
        const page = await listConversations(pageSize, undefined, offset, "all");
        for (const row of page) rows.set(row.id, { id: row.id, title: row.title, createdAt: row.createdAt });
        if (page.length < pageSize) break;
      }
    } catch {
      // Excerpts, roles, and source timestamps still make the evidence understandable.
    }
    conversationSnapshot = { expiresAt: Date.now() + 60_000, rows };
    return rows;
  })();
  try { return await conversationSnapshotPromise; } finally { conversationSnapshotPromise = null; }
}

export async function enrichProvenance(items: ProvenanceItem[]): Promise<DisplayProvenanceItem[]> {
  if (items.length === 0) return [];
  const resolved = await conversationMetadata();
  return items.map((item) => {
    const conversation = item.conversationId ? resolved.get(item.conversationId) ?? null : null;
    const speaker = item.role === "user" ? "You" : item.role === "assistant" ? "Assistant" : "Conversation";
    return {
      ...item,
      conversationTitle: conversation?.title ?? null,
      conversationDate: conversation?.createdAt ?? null,
      label: conversation?.title ? `${speaker} in ${conversation.title}` : `${speaker} message`,
    };
  });
}
