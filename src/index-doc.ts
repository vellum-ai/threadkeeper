/**
 * Wrapper over the plugin-scoped private semantic index (`indexDocument` / `queryIndex` /
 * `removeDocument`). SQLite is canonical; this index is a rebuildable derived cache — every write
 * here fails gracefully and never rolls back or blocks a canonical SQLite commit (plan §14).
 */
import { getDocument, indexDocument, queryIndex, removeDocument } from "@vellumai/plugin-api";
import { getDb } from "./db.ts";
import { contentHash } from "./ids.ts";
import { getIndexDocumentByOwner, listIndexDocuments, recordIndexDocument, removeIndexDocumentRecord } from "./repositories/audit.ts";

export function documentIdFor(ownerType: string, ownerId: string): string {
  return `${ownerType}:${ownerId}`;
}

export interface IndexOwnerResult {
  ok: boolean;
  documentId: string;
  errorCode?: "INDEX_WRITE_FAILED";
}

/** Index (or re-index, unchanged content is a no-op) a derived document for one owner row. */
export async function indexOwner(ownerType: string, ownerId: string, text: string, metadata?: Record<string, unknown>): Promise<IndexOwnerResult> {
  const documentId = documentIdFor(ownerType, ownerId);
  const hash = contentHash(text);
  const db = getDb();
  const existing = getIndexDocumentByOwner(db, ownerType, ownerId);
  if (existing && existing.content_hash === hash) return { ok: true, documentId };
  try {
    await indexDocument(text, { documentId, metadata: { ownerType, ownerId, ...metadata } });
    recordIndexDocument(db, documentId, ownerType, ownerId, hash);
    return { ok: true, documentId };
  } catch {
    return { ok: false, documentId, errorCode: "INDEX_WRITE_FAILED" };
  }
}

export async function removeOwnerDocument(ownerType: string, ownerId: string): Promise<void> {
  const documentId = documentIdFor(ownerType, ownerId);
  try {
    await removeDocument(documentId);
  } catch {
    // Best-effort: the ledger row is still cleared below so a later reconciliation pass can retry.
  }
  removeIndexDocumentRecord(getDb(), documentId);
}

export interface OwnerHit {
  ownerType: string;
  ownerId: string;
  score: number;
  text: string;
}

export async function queryOwners(query: string, limit: number, ownerTypes?: string[]): Promise<OwnerHit[]> {
  try {
    const hits = await queryIndex(query, { limit: Math.max(limit * 2, limit) });
    const out: OwnerHit[] = [];
    for (const hit of hits) {
      const metadata = (hit.metadata ?? {}) as { ownerType?: string; ownerId?: string };
      if (!metadata.ownerType || !metadata.ownerId) continue;
      if (ownerTypes && !ownerTypes.includes(metadata.ownerType)) continue;
      out.push({ ownerType: metadata.ownerType, ownerId: metadata.ownerId, score: hit.score, text: hit.text });
      if (out.length >= limit) break;
    }
    return out;
  } catch {
    return [];
  }
}

export async function getOwnerDocument(ownerType: string, ownerId: string): Promise<string | null> {
  try {
    const doc = await getDocument(documentIdFor(ownerType, ownerId));
    return doc?.text ?? null;
  } catch {
    return null;
  }
}

/** Remove index documents whose owner row no longer exists in SQLite. Returns how many were dropped. */
export async function reconcileIndexDrift(isValidOwner: (ownerType: string, ownerId: string) => boolean): Promise<{ checked: number; removed: number }> {
  const db = getDb();
  const rows = listIndexDocuments(db);
  let removed = 0;
  for (const row of rows) {
    if (!isValidOwner(row.owner_type, row.owner_id)) {
      await removeOwnerDocument(row.owner_type, row.owner_id);
      removed++;
    }
  }
  return { checked: rows.length, removed };
}
