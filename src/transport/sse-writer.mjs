// SSE writer helpers shared by chat/responses endpoints.
export function sseWrite(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export function sseEvent(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export function sseDone(res) {
  res.write("data: [DONE]\n\n");
}

