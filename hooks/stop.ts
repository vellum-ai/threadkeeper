/**
 * Fast live-capture path. Fires once per turn, after the loop has committed to ending. Must stay
 * well under the 20ms p95 target: one SQLite upsert, nothing else. Never parses `ctx.messages` —
 * the background worker fetches persisted rows by id instead. Fails open on any error so a
 * Threadkeeper outage never affects ordinary conversation.
 */
import type { HookFunction, StopContext } from "@vellumai/plugin-api";
import { captureStop } from "../src/capture.ts";
import { toErrorInfo } from "../src/errors.ts";

const stop: HookFunction<StopContext> = async (ctx) => {
  try {
    captureStop(ctx.conversationId, null);
  } catch (cause) {
    const info = toErrorInfo(cause);
    try {
      ctx.logger.warn({ errorCode: info.code, conversationId: ctx.conversationId }, "threadkeeper stop capture failed");
    } catch {
      // Logger itself is unavailable — still fail open.
    }
  }
};

export default stop;
