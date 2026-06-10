import crypto from "node:crypto";
import { readFile } from "node:fs/promises";

const DEEPSEEK_BASE_URL = "https://chat.deepseek.com";
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

let wasmInstancePromise = null;

function normalizeModel(model = "") {
  const id = String(model || "deepseek-chat").replace(/^deepseek-web\//, "");
  if (id.includes("reasoner") || id.includes("r1")) return "deepseek-reasoner";
  return "deepseek-chat";
}

function hasMeaningfulText(value) {
  return typeof value === "string" && value.length > 0;
}

async function loadDeepSeekHashWasm() {
  if (wasmInstancePromise) return wasmInstancePromise;

  wasmInstancePromise = (async () => {
    const sourcePath = process.env.DEEPSEEK_POW_SOURCE_PATH;
    if (!sourcePath) {
      throw new Error(
        "DeepSeekHashV1 PoW requires DEEPSEEK_POW_SOURCE_PATH. Set it to the PoW dependency source file.",
      );
    }
    const source = await readFile(sourcePath, "utf8");
    const match = source.match(/const SHA3_WASM_B64\s*=\s*"([^"]+)";/);
    if (!match) {
      throw new Error(`Could not find PoW WASM in dependency source file: ${sourcePath}`);
    }
    const wasmBuffer = Buffer.from(match[1], "base64");
    const { instance } = await WebAssembly.instantiate(wasmBuffer, { wbg: {} });
    return instance;
  })();

  return wasmInstancePromise;
}

export class DeepSeekWebClient {
  constructor(options = {}) {
    this.cookie = options.cookie || "";
    this.bearer = options.bearer || "";
    this.userAgent = options.userAgent || DEFAULT_USER_AGENT;
  }

  async fetchHeaders() {
    return {
      Cookie: this.cookie,
      "User-Agent": this.userAgent,
      "Content-Type": "application/json",
      Accept: "*/*",
      ...(this.bearer ? { Authorization: `Bearer ${this.bearer}` } : {}),
      Referer: `${DEEPSEEK_BASE_URL}/`,
      Origin: DEEPSEEK_BASE_URL,
      "x-client-platform": "web",
      "x-client-version": "1.7.0",
      "x-app-version": "20241129.1",
      "x-client-locale": "zh_CN",
      "x-client-timezone-offset": "28800",
    };
  }

  async init() {
    await fetch(`${DEEPSEEK_BASE_URL}/api/v0/client/settings?did=&scope=banner`, {
      headers: await this.fetchHeaders(),
    }).catch(() => null);
  }

  async createPowChallenge(targetPath) {
    const res = await fetch(`${DEEPSEEK_BASE_URL}/api/v0/chat/create_pow_challenge`, {
      method: "POST",
      headers: await this.fetchHeaders(),
      body: JSON.stringify({ target_path: targetPath }),
    });

    if (!res.ok) {
      throw new Error(`创建 DeepSeek PoW 失败：${res.status} ${await res.text()}`);
    }

    const data = await res.json();
    const challenge = data.data?.biz_data?.challenge || data.data?.challenge || data.challenge;
    if (!challenge) {
      throw new Error("DeepSeek PoW 返回里没有 challenge");
    }
    return challenge;
  }

  async solvePow(challenge) {
    const { algorithm, challenge: target, salt, difficulty, expire_at: expireAt } = challenge;

    if (algorithm === "sha256") {
      let nonce = 0;
      while (nonce <= 1_000_000) {
        const input = `${salt}${target}${nonce}`;
        const hash = crypto.createHash("sha256").update(input).digest("hex");
        let zeroBits = 0;
        for (const char of hash) {
          const value = Number.parseInt(char, 16);
          if (value === 0) {
            zeroBits += 4;
          } else {
            zeroBits += Math.clz32(value) - 28;
            break;
          }
        }
        const targetDifficulty = difficulty > 1000 ? Math.floor(Math.log2(difficulty)) : difficulty;
        if (zeroBits >= targetDifficulty) {
          return nonce;
        }
        nonce++;
      }
      throw new Error("DeepSeek sha256 PoW 计算超时");
    }

    if (algorithm === "DeepSeekHashV1") {
      const instance = await loadDeepSeekHashWasm();
      const exports = instance.exports;
      const memory = exports.memory;
      const alloc = exports.__wbindgen_export_0;
      const addToStack = exports.__wbindgen_add_to_stack_pointer;
      const wasmSolve = exports.wasm_solve;

      const encodeString = (value) => {
        const buffer = Buffer.from(value, "utf8");
        const ptr = alloc(buffer.length, 1);
        new Uint8Array(memory.buffer).set(buffer, ptr);
        return [ptr, buffer.length];
      };

      const [ptrC, lenC] = encodeString(target);
      const [ptrP, lenP] = encodeString(`${salt}_${expireAt}_`);
      const retptr = addToStack(-16);
      wasmSolve(retptr, ptrC, lenC, ptrP, lenP, difficulty);

      const view = new DataView(memory.buffer);
      const status = view.getInt32(retptr, true);
      const answer = view.getFloat64(retptr + 8, true);
      addToStack(16);

      if (status === 0) {
        throw new Error("DeepSeekHashV1 PoW 没有找到答案");
      }
      return answer;
    }

    throw new Error(`不支持的 DeepSeek PoW 算法：${algorithm}`);
  }

  async createChatSession() {
    const targetPath = "/api/v0/chat_session/create";
    const res = await fetch(`${DEEPSEEK_BASE_URL}${targetPath}`, {
      method: "POST",
      headers: await this.fetchHeaders(),
      body: JSON.stringify({}),
    });

    if (!res.ok) {
      throw new Error(`创建 DeepSeek 会话失败：${res.status} ${await res.text()}`);
    }

    const data = await res.json();
    const session = data.data?.biz_data || {};
    const sessionId = session.id || session.chat_session_id || "";
    if (!sessionId) {
      throw new Error("DeepSeek 会话返回里没有 session id");
    }
    return {
      ...session,
      chat_session_id: sessionId,
    };
  }

  async chatCompletions(params) {
    const targetPath = "/api/v0/chat/completion";
    const challenge = await this.createPowChallenge(targetPath);
    const answer = await this.solvePow(challenge);
    const powResponse = Buffer.from(
      JSON.stringify({
        ...challenge,
        answer,
        target_path: targetPath,
      }),
    ).toString("base64");

    const model = normalizeModel(params.model);
    const res = await fetch(`${DEEPSEEK_BASE_URL}${targetPath}`, {
      method: "POST",
      headers: {
        ...(await this.fetchHeaders()),
        "x-ds-pow-response": powResponse,
      },
      body: JSON.stringify({
        chat_session_id: params.sessionId,
        parent_message_id: params.parentMessageId ?? null,
        prompt: params.message,
        ref_file_ids: params.fileIds || [],
        thinking_enabled: model !== "deepseek-chat",
        search_enabled: params.searchEnabled ?? false,
        preempt: params.preempt ?? false,
      }),
      signal: params.signal,
    });

    if (!res.ok) {
      throw new Error(`DeepSeek 对话请求失败：${res.status} ${await res.text()}`);
    }
    if (!res.body) {
      throw new Error("DeepSeek 对话没有返回流");
    }
    return res.body;
  }
}

export function deepSeekEventsFromSseData(data) {
  const events = [];

  if (hasMeaningfulText(data.response_message_id)) {
    events.push({ type: "meta", parentMessageId: data.response_message_id });
  }

  const pushText = (delta) => {
    if (hasMeaningfulText(delta)) events.push({ type: "text", delta });
  };
  const pushReasoning = (delta) => {
    if (hasMeaningfulText(delta)) events.push({ type: "reasoning", delta });
  };

  if ((data.p?.includes("reasoning") || data.type === "thinking") && hasMeaningfulText(data.v)) {
    pushReasoning(data.v);
    return events;
  }
  if (data.type === "thinking" && hasMeaningfulText(data.content)) {
    pushReasoning(data.content);
    return events;
  }
  if (hasMeaningfulText(data.v) && (!data.p || data.p.includes("content") || data.p.includes("choices"))) {
    pushText(data.v);
    return events;
  }
  if (data.type === "text" && hasMeaningfulText(data.content)) {
    pushText(data.content);
    return events;
  }

  if (Array.isArray(data.v)) {
    for (const fragment of data.v) {
      if (fragment?.type === "THINKING" || fragment?.type === "reasoning") {
        pushReasoning(fragment.content || "");
      } else {
        pushText(fragment?.content || "");
      }
    }
    return events;
  }

  const fragments = data.v?.response?.fragments;
  if (Array.isArray(fragments)) {
    for (const fragment of fragments) {
      if (fragment?.type === "THINKING" || fragment?.type === "reasoning") {
        pushReasoning(fragment.content || "");
      } else {
        pushText(fragment?.content || "");
      }
    }
    return events;
  }

  const choice = data.choices?.[0];
  if (choice?.delta?.reasoning_content) pushReasoning(choice.delta.reasoning_content);
  if (choice?.delta?.content) pushText(choice.delta.content);

  return events;
}

export async function* parseDeepSeekStream(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line.startsWith("data: ")) continue;

      const payload = line.slice(6).trim();
      if (!payload || payload === "[DONE]") continue;

      try {
        const data = JSON.parse(payload);
        for (const event of deepSeekEventsFromSseData(data)) {
          yield event;
        }
      } catch {
        // Ignore partial or non-JSON SSE payloads.
      }
    }
  }

  const tail = buffer.trim();
  if (tail.startsWith("data: ")) {
    const payload = tail.slice(6).trim();
    if (payload && payload !== "[DONE]") {
      try {
        const data = JSON.parse(payload);
        for (const event of deepSeekEventsFromSseData(data)) {
          yield event;
        }
      } catch {
        // Ignore partial or non-JSON SSE payloads.
      }
    }
  }
}
