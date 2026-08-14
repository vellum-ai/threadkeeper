/**
 * Cleanup signal for one deleted conversation. Fire-and-forget per the host contract — no ordering
 * guarantee relative to the delete call — so this must be idempotent and safe to run late or
 * twice. Fails open: a cleanup failure is logged, never thrown into the host.
 */
import type { ConversationDeletedContext, HookFunction } from "@vellumai/plugin-api";
import { handleConversationDeleted } from "../src/deletion.ts";
import { toErrorInfo } from "../src/errors.ts";

const conversationDeleted: HookFunction<ConversationDeletedContext> = async (ctx) => {
  try {
    await handleConversationDeleted(ctx.conversationId);
  } catch (cause) {
    const info = toErrorInfo(cause);
    try {
      ctx.logger.warn({ errorCode: info.code, conversationId: ctx.conversationId }, "threadkeeper conversation-deleted cleanup failed");
    } catch {
      // Fail open regardless.
    }
  }
};

export default conversationDeleted;
