// Event factory untuk orkestrasi: tiap event wajib membawa ctx { requestId, created, model }.
export const evPhase     = (ctx, phase) => ({ type: "phase", ctx, phase });
export const evMeta      = (ctx, parentMessageId) => ({ type: "meta", ctx, parentMessageId });
export const evText      = (ctx, delta) => ({ type: "text_delta", ctx, delta });
export const evReasoning = (ctx, delta) => ({ type: "reasoning_delta", ctx, delta });
export const evToolStart = (ctx, callId, name, kind) => ({ type: "tool_call_start", ctx, callId, name, kind });
export const evToolArgs  = (ctx, callId, delta) => ({ type: "tool_call_args_delta", ctx, callId, delta });
export const evToolDone  = (ctx, callId, payload) => ({ type: "tool_call_done", ctx, callId, payload });
export const evDone      = (ctx, status) => ({ type: "done", ctx, status });
export const evError     = (ctx, code, message, retryable = false) => ({ type: "error", ctx, code, message, retryable });
