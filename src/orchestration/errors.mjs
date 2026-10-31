export const ErrorCode = {
  AUTH_MISSING: "auth_missing",
  AUTH_EXPIRED: "auth_expired",
  SESSION_CREATE_FAILED: "session_create_failed",
  POW_FAILED: "pow_failed",
  UPSTREAM_TIMEOUT: "upstream_timeout",
  UPSTREAM_STREAM_BROKEN: "upstream_stream_broken",
  TOOL_LOOP_EXCEEDED: "tool_loop_exceeded",
  CANCELLED: "cancelled",
  INVALID_REQUEST: "invalid_request",
};

export class BridgeError extends Error {
  constructor(code, message, { phase, retryable, cause } = {}) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    this.phase = phase;
    this.retryable = retryable;
    this.cause = cause;
  }
}

const RETRYABLE_CODES = new Set([
  ErrorCode.UPSTREAM_TIMEOUT,
  ErrorCode.UPSTREAM_STREAM_BROKEN,
]);

export function isRetryable(code) {
  return RETRYABLE_CODES.has(code);
}
