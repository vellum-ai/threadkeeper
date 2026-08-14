/** Dev-only clear-all signal: purge every conversation-derived Threadkeeper record. Idempotent. */
import type { ConversationsClearedContext, HookFunction } from "@vellumai/plugin-api";
import { handleConversationsCleared } from "../src/deletion.ts";
import { toErrorInfo } from "../src/errors.ts";

const conversationsCleared: HookFunction<ConversationsClearedContext> = async (ctx) => {
  try {
    await handleConversationsCleared();
  } catch (cause) {
    const info = toErrorInfo(cause);
    try {
      ctx.logger.warn({ errorCode: info.code }, "threadkeeper conversations-cleared cleanup failed");
    } catch {
      // Fail open regardless.
    }
  }
};

export default conversationsCleared;
