export const ERROR_CODES = [
  "DB_UNAVAILABLE",
  "MIGRATION_FAILED",
  "NO_PROVIDER",
  "PROVIDER_TIMEOUT",
  "PROVIDER_ERROR",
  "INVALID_MODEL_JSON",
  "CONVERSATION_ACTIVE",
  "SOURCE_MISSING",
  "INDEX_WRITE_FAILED",
  "TOMBSTONED",
  "JOB_LEASE_EXPIRED",
  "ROUTE_VALIDATION_FAILED",
  "NOT_FOUND",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export class ThreadkeeperError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "ThreadkeeperError";
    this.code = code;
  }
}

export function isThreadkeeperError(value: unknown): value is ThreadkeeperError {
  return value instanceof ThreadkeeperError;
}

/** Reduce any thrown value to a stable (code, message) pair, never leaking raw content. */
export function toErrorInfo(cause: unknown): { code: ErrorCode; message: string } {
  if (isThreadkeeperError(cause)) return { code: cause.code, message: cause.message };
  if (cause instanceof Error) return { code: "DB_UNAVAILABLE", message: cause.message.slice(0, 200) };
  return { code: "DB_UNAVAILABLE", message: "unknown failure" };
}
