// Pipeline: menjalankan satu chat completion DeepSeek Web dan melemparkan event internal.
import { parseDeepSeekStream } from "./../deepseek-web-client.mjs";
import { evMeta, evText, evReasoning, evDone } from "./events.mjs";

export function createPipeline({ authManager, sessionStore, log = () => {}, defaultModel = "deepseek-web/deepseek-chat" }) {
  async function ensureSession(client, sessionKey) {
    const cached = sessionStore.get(sessionKey);
    if (cached?.sessionId) return cached;
    const session = await client.createChatSession();
    const next = { sessionId: session.chat_session_id, parentMessageId: null };
    sessionStore.set(sessionKey, next);
    return next;
  }

  return {
    async *runChatCompletion(normalized, ctx, signal) {
      const sessionKey = normalized.sessionKey || "default";
      const model = normalized.model || defaultModel;
      const prompt = normalized.prompt || "";

      if (!prompt.trim()) {
        throw new Error("没有可发送给 DeepSeek 的消息。");
      }

      const client = await authManager.getClient(signal);
      const session = await ensureSession(client, sessionKey);

      log(`发送到 DeepSeek Web：${prompt.slice(0, 60).replace(/\s+/g, " ")}`);

      const deepSeekStream = await client.chatCompletions({
        sessionId: session.sessionId,
        parentMessageId: session.parentMessageId,
        message: prompt,
        model,
        searchEnabled: Boolean(normalized.searchEnabled),
        signal,
      });

      let fullText = "";
      for await (const event of parseDeepSeekStream(deepSeekStream)) {
        if (event.type === "meta" && event.parentMessageId) {
          session.parentMessageId = event.parentMessageId;
          sessionStore.set(sessionKey, session);
          yield evMeta(ctx, event.parentMessageId);
          continue;
        }

        if (event.type !== "text" && event.type !== "reasoning") continue;
        const delta = event.delta || "";
        if (!delta) continue;
        if (event.type === "text") {
          fullText += delta;
          yield evText(ctx, delta);
        } else {
          yield evReasoning(ctx, delta);
        }
      }

      log(`DeepSeek Web 回复完成：${fullText.length} 字符。`);
      yield evDone(ctx, { content: fullText });
    },
  };
}
