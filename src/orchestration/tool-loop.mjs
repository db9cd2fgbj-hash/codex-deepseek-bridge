// tool-loop: pembungkus pipeline dengan budget langkah; versi ini satu langkah per pemanggilan.
import { evToolDone } from "./events.mjs";

export async function* runToolLoop({ pipeline, normalized, tools, budget = 8, ctx, signal, parseToolCall }) {
  const steps = Math.max(1, Math.floor(budget));

  for (let step = 0; step < steps; step += 1) {
    let fullText = "";
    for await (const event of pipeline.runChatCompletion(normalized, ctx, signal)) {
      if (event.type === "text_delta" && event.delta) fullText += event.delta;
      yield event;
    }

    if (!tools.length || !fullText) return;

    const call = parseToolCall?.(fullText, tools);
    if (!call) return;

    const callId = call.id || `call_ds_${Date.now()}_${step}`;
    yield evToolDone(ctx, callId, {
      id: callId,
      name: call.spec.name,
      kind: call.spec.kind,
      arguments: call.arguments,
      spec: call.spec,
    });

    return;

    // TODO(task 9b): multi-step — hasil tool di-append ke normalized lalu round berikutnya
    // memakai langkah baru dari `steps`; budget mencegah loop tanpa henti.
  }
}
