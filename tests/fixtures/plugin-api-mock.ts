/**
 * Shared mock of `@vellumai/plugin-api`, installed once via `mock.module` at import time. Every
 * test file that needs it must import this fixture BEFORE importing any `src/` module (ESM
 * evaluates dependencies before dependents, so the mock lands in the module registry first).
 * Tests reconfigure behavior through the shared mutable `mockState`, reset in `beforeEach`.
 */
import { mock } from "bun:test";

export interface MockMessage {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  content: Array<{ type: string; text?: string }>;
  createdAt: number;
  finalized: number;
}

export interface MockConversation {
  id: string;
  title: string | null;
  createdAt: number;
  updatedAt: number;
}

export type ProviderImpl = (systemPrompt: string, userText: string) => Promise<string> | string;

export const mockState: {
  messagesByConversation: Map<string, MockMessage[]>;
  conversations: MockConversation[];
  processingConversationIds: Set<string>;
  providerImpl: ProviderImpl | null;
  indexDocuments: Map<string, { text: string; metadata?: Record<string, unknown>; modality: string; createdAt: number }>;
  lexicalHits: Array<{ messageId: string; score: number }>;
  hasLexicalTokensResult: boolean;
  workspaceDir: string;
  calls: Record<string, number>;
  indexShouldFail: boolean;
} = {
  messagesByConversation: new Map(),
  conversations: [],
  processingConversationIds: new Set(),
  providerImpl: null,
  indexDocuments: new Map(),
  lexicalHits: [],
  hasLexicalTokensResult: true,
  workspaceDir: "/tmp/threadkeeper-test-workspace",
  calls: { getMessages: 0, getConfiguredProvider: 0 } as Record<string, number>,
  indexShouldFail: false,
};

let messageCounter = 0;

/** Append a finalized mock message to a conversation, creating it in `mockState.messagesByConversation`. */
export function addMockMessage(
  conversationId: string,
  role: "user" | "assistant",
  text: string,
  createdAt: number,
  opts?: { finalized?: number; id?: string },
): MockMessage {
  const message: MockMessage = {
    id: opts?.id ?? `msg-${++messageCounter}`,
    conversationId,
    role,
    content: [{ type: "text", text }],
    createdAt,
    finalized: opts?.finalized ?? 1,
  };
  const list = mockState.messagesByConversation.get(conversationId) ?? [];
  list.push(message);
  mockState.messagesByConversation.set(conversationId, list);
  return message;
}

export function resetMockState(): void {
  mockState.messagesByConversation.clear();
  mockState.conversations = [];
  mockState.processingConversationIds.clear();
  mockState.providerImpl = null;
  mockState.indexDocuments.clear();
  mockState.lexicalHits = [];
  mockState.hasLexicalTokensResult = true;
  mockState.calls = { getMessages: 0, getConfiguredProvider: 0 };
  mockState.indexShouldFail = false;
}

function stringifyMessageContent(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n");
}

let docCounter = 0;

mock.module("@vellumai/plugin-api", () => ({
  getWorkspaceDir: () => mockState.workspaceDir,

  getMessages: async (conversationId: string) => {
    mockState.calls.getMessages = (mockState.calls.getMessages ?? 0) + 1;
    return mockState.messagesByConversation.get(conversationId) ?? [];
  },

  isConversationProcessing: async (conversationId: string) => mockState.processingConversationIds.has(conversationId),

  listConversations: async (limit?: number, _conversationType?: unknown, offset = 0) =>
    mockState.conversations.slice(offset, offset + (limit ?? mockState.conversations.length)),

  hasLexicalTokens: async (text: string) => mockState.hasLexicalTokensResult && text.trim().length > 0,

  searchMessageIdsLexical: async (_query: string, limit: number) => mockState.lexicalHits.slice(0, limit),

  stringifyMessageContent,
  extractTextFromStoredMessageContent: stringifyMessageContent,

  getConfiguredProvider: async () => {
    mockState.calls.getConfiguredProvider = (mockState.calls.getConfiguredProvider ?? 0) + 1;
    if (!mockState.providerImpl) return null;
    return {
      name: "mock",
      async sendMessage(messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }>, options?: { systemPrompt?: string }) {
        const userText = messages[0]?.content?.find((b) => b.type === "text")?.text ?? "";
        const reply = await mockState.providerImpl!(options?.systemPrompt ?? "", userText);
        return { content: [{ type: "text", text: reply }], model: "mock-model", stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 } };
      },
    };
  },

  indexDocument: async (input: string, opts?: { documentId?: string; metadata?: Record<string, unknown> }) => {
    if (mockState.indexShouldFail) throw new Error("simulated index outage");
    const documentId = opts?.documentId ?? `doc-${++docCounter}`;
    mockState.indexDocuments.set(documentId, { text: String(input), metadata: opts?.metadata, modality: "text", createdAt: Date.now() });
    return { documentId, provider: "mock", model: "mock", dimensions: 1 };
  },

  queryIndex: async (_query: string, opts?: { limit?: number }) => {
    const limit = opts?.limit ?? 10;
    return [...mockState.indexDocuments.entries()]
      .slice(0, limit)
      .map(([documentId, doc]) => ({ documentId, score: 0.9, text: doc.text, modality: doc.modality, metadata: doc.metadata }));
  },

  getDocument: async (documentId: string) => {
    const doc = mockState.indexDocuments.get(documentId);
    return doc ? { documentId, text: doc.text, modality: doc.modality, metadata: doc.metadata, createdAt: doc.createdAt } : null;
  },

  removeDocument: async (documentId: string) => {
    mockState.indexDocuments.delete(documentId);
  },
}));
