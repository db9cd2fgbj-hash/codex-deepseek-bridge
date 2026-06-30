import { createReadStream, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AUTH_PATH,
  DEFAULT_PORT as DEFAULT_CDP_PORT,
  readCredentials,
  runDeepSeekLogin,
  summarizeCredentials,
} from "./deepseek-auth.mjs";
import { DeepSeekWebClient, parseDeepSeekStream } from "./deepseek-web-client.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const DEFAULT_UI_PORT = 8787;
const CHAT_MODEL = "deepseek-web/deepseek-chat";
const REASONER_MODEL = "deepseek-web/deepseek-reasoner";
const DEFAULT_API_KEY_HINT = "deepseek";

const state = {
  running: false,
  lastError: "",
  logs: [],
  clients: new Set(),
  chatSessions: new Map(),
  responseSessions: new Map(),
  toolCalls: new Map(),
};

function nowStamp() {
  return new Date().toLocaleTimeString("zh-CN", { hour12: false });
}

function pushLog(message, level = "info") {
  const entry = {
    id: Date.now() + Math.random(),
    at: nowStamp(),
    level,
    message,
  };
  state.logs.push(entry);
  state.logs = state.logs.slice(-120);
  for (const client of state.clients) {
    client.write(`data: ${JSON.stringify(entry)}\n\n`);
  }
  console.log(`[ui] ${message}`);
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function notFound(res) {
  sendJson(res, 404, { error: "not_found" });
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".png") return "image/png";
  return "application/octet-stream";
}

function safePublicPath(urlPath) {
  const pathname = urlPath === "/" ? "/index.html" : urlPath;
  const decoded = decodeURIComponent(pathname);
  const normalized = path.normalize(decoded).replace(/^(\.\.[/\\])+/, "");
  const fullPath = path.join(PUBLIC_DIR, normalized);
  if (!fullPath.startsWith(PUBLIC_DIR)) {
    return null;
  }
  return fullPath;
}

async function readJsonBody(req, maxBytes = 2_000_000) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new Error("请求体太大");
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

async function statusPayload() {
  const credentials = await readCredentials();
  return {
    running: state.running,
    lastError: state.lastError,
    authPath: AUTH_PATH,
    gateway: {
      baseUrl: `http://127.0.0.1:${Number(process.env.PORT || DEFAULT_UI_PORT)}/v1`,
      apiKey: DEFAULT_API_KEY_HINT,
      responsesEndpoint: "/v1/responses",
      chatEndpoint: "/v1/chat/completions",
      models: [CHAT_MODEL, REASONER_MODEL],
      toolCalling: {
        enabled: true,
        strategy: "prompt-xml-to-responses-events",
        events: [
          "response.function_call_arguments.done",
          "response.custom_tool_call_input.done",
        ],
      },
    },
    credentials: summarizeCredentials(credentials),
    recentLogs: state.logs.slice(-50),
  };
}

async function startLogin(res) {
  if (state.running) {
    sendJson(res, 409, { ok: false, error: "login_already_running" });
    return;
  }

  state.running = true;
  state.lastError = "";
  pushLog("登录流程已启动。");
  sendJson(res, 202, { ok: true });

  void runDeepSeekLogin({
    port: DEFAULT_CDP_PORT,
    onProgress: (message) => pushLog(message),
  })
    .then(() => {
      pushLog("凭证已保存，可以测试对话。");
    })
    .catch((error) => {
      state.lastError = error?.message || String(error);
      pushLog(state.lastError, "error");
    })
    .finally(() => {
      state.running = false;
    });
}

async function handleSse(req, res) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  for (const entry of state.logs.slice(-30)) {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  }
  state.clients.add(res);
  req.on("close", () => {
    state.clients.delete(res);
  });
}

async function makeDeepSeekClient() {
  const credentials = await readCredentials();
  if (!credentials?.cookie || !credentials?.bearer) {
    throw new Error("还没有 DeepSeek 登录凭证，请先登录。");
  }
  const client = new DeepSeekWebClient(credentials);
  await client.init();
  return client;
}

function modelPayload() {
  return {
    object: "list",
    data: [
      {
        id: CHAT_MODEL,
        object: "model",
        created: 0,
        owned_by: "deepseek-web",
      },
      {
        id: REASONER_MODEL,
        object: "model",
        created: 0,
        owned_by: "deepseek-web",
      },
    ],
  };
}

function messagesToPrompt(messages = []) {
  if (!Array.isArray(messages)) return "";

  return messages
    .map((message) => {
      const role = message.role || "user";
      if (role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
        const calls = message.tool_calls
          .map((toolCall) => {
            const name = toolCall?.function?.name || toolCall?.name || "tool";
            const args = toolCall?.function?.arguments || toolCall?.arguments || "";
            return `${name}${args ? `(${args})` : ""}`;
          })
          .join(", ");
        return calls ? `assistant requested tools: ${calls}` : "";
      }

      let content = "";
      if (typeof message.content === "string") {
        content = message.content;
      } else if (Array.isArray(message.content)) {
        content = message.content
          .map((part) => {
            if (typeof part === "string") return part;
            if (typeof part?.text === "string") return part.text;
            if (typeof part?.content === "string") return part.content;
            return "";
          })
          .filter(Boolean)
          .join("\n");
      }
      if (role === "tool") {
        const name = message.name || message.tool_call_id || "tool";
        return content.trim() ? `tool result from ${name}: ${content.trim()}` : "";
      }
      return content.trim() ? `${role}: ${content.trim()}` : "";
    })
    .filter(Boolean)
    .join("\n\n");
}

function responseContentPartToText(part) {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object") return "";
  if (typeof part.text === "string") return part.text;
  if (typeof part.content === "string") return part.content;
  if (typeof part.input_text === "string") return part.input_text;
  if (typeof part.output_text === "string") return part.output_text;
  return "";
}

function responseToolName(tool) {
  if (!tool || typeof tool !== "object") return "";
  const source = tool.function && typeof tool.function === "object" ? tool.function : tool;
  return String(source.name || tool.name || "").trim();
}

function responseToolDescription(tool) {
  if (!tool || typeof tool !== "object") return "";
  const source = tool.function && typeof tool.function === "object" ? tool.function : tool;
  return String(source.description || tool.description || "").trim();
}

function responseToolParameters(tool) {
  if (!tool || typeof tool !== "object") return {};
  const source = tool.function && typeof tool.function === "object" ? tool.function : tool;
  return source.parameters || source.input_schema || tool.parameters || tool.input_schema || {};
}

function extractResponseTools(body = {}) {
  if (!Array.isArray(body.tools)) return [];

  const tools = [];
  for (const tool of body.tools) {
    if (!tool || typeof tool !== "object") continue;

    if (tool.type === "custom") {
      const name = responseToolName(tool);
      if (!name) continue;
      tools.push({
        kind: "custom",
        name,
        wireName: name,
        description: responseToolDescription(tool),
        parameters: { type: "string" },
      });
      continue;
    }

    if (tool.type === "tool_search") {
      tools.push({
        kind: "tool_search",
        name: "tool_search",
        wireName: "tool_search",
        description: "Search and load available Codex tools.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" },
            limit: { type: "integer" },
          },
        },
      });
      continue;
    }

    const name = responseToolName(tool);
    if (!name) continue;
    const namespace = String(tool.namespace || tool.function?.namespace || "").trim();
    tools.push({
      kind: "function",
      name,
      wireName: namespace ? `${namespace}.${name}` : name,
      namespace,
      description: responseToolDescription(tool),
      parameters: responseToolParameters(tool),
    });
  }

  return tools;
}

function extractChatTools(body = {}) {
  if (!Array.isArray(body.tools)) return [];

  return body.tools
    .map((tool) => {
      if (!tool || typeof tool !== "object") return null;
      const name = responseToolName(tool);
      if (!name) return null;
      return {
        kind: "function",
        name,
        wireName: name,
        description: responseToolDescription(tool),
        parameters: responseToolParameters(tool),
      };
    })
    .filter(Boolean);
}

function stringifyForPrompt(value, maxChars = 1800) {
  let text = "";
  try {
    text = JSON.stringify(value ?? {}, null, 2);
  } catch {
    text = String(value ?? "");
  }
  return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
}

function buildToolPrompt(tools) {
  if (!tools.length) return "";

  const definitions = tools.map((tool) => ({
    name: tool.wireName,
    type: tool.kind,
    description: tool.description,
    parameters: tool.parameters,
  }));

  return [
    "system: You have access to client-side tools. Use a tool when it is needed to inspect files, run commands, edit files, or fetch external context.",
    "When you use a normal function tool, reply with ONLY this XML and no extra text:",
    '<tool_call name="TOOL_NAME">{"arg":"value"}</tool_call>',
    "When you use a custom/raw-input tool such as apply_patch, put the raw input inside the tag and preserve formatting exactly:",
    '<tool_call name="apply_patch">RAW_INPUT_HERE</tool_call>',
    "If no tool is needed, answer normally.",
    "Available tools:",
    stringifyForPrompt(definitions, 30000),
  ].join("\n");
}

function rememberToolCall(item) {
  if (!item?.call_id) return;
  state.toolCalls.set(item.call_id, {
    name: item.name || "tool",
    type: item.type || "function_call",
  });

  if (state.toolCalls.size > 500) {
    const firstKey = state.toolCalls.keys().next().value;
    if (firstKey) state.toolCalls.delete(firstKey);
  }
}

function responseInputItemToText(item) {
  if (typeof item === "string") return item;
  if (!item || typeof item !== "object") return "";

  const type = item.type || "message";
  if (type === "function_call_output" || type === "custom_tool_call_output") {
    const output = responseContentPartToText(item.output) || responseContentPartToText(item.content);
    const callId = item.call_id || item.id || "";
    const cached = callId ? state.toolCalls.get(callId) : null;
    const toolName = item.name || cached?.name || "tool";
    return output ? `tool result from ${toolName}${callId ? ` (${callId})` : ""}: ${output}` : "";
  }

  if (type === "function_call" || type === "custom_tool_call" || type === "tool_search_call") {
    rememberToolCall(item);
    const toolName = item.name || "tool";
    const callId = item.call_id || item.id || "";
    const args =
      type === "custom_tool_call"
        ? responseContentPartToText(item.input)
        : responseContentPartToText(item.arguments) || stringifyForPrompt(item.arguments, 4000);
    return `assistant requested ${toolName}${callId ? ` (${callId})` : ""}: ${args}`;
  }

  if (type !== "message" && type !== "input_text" && type !== "output_text") {
    return "";
  }

  const role = item.role || "user";
  const content = Array.isArray(item.content)
    ? item.content.map(responseContentPartToText).filter(Boolean).join("\n")
    : responseContentPartToText(item.content || item.text || item);

  return content.trim() ? `${role}: ${content.trim()}` : "";
}

function responsesToPrompt(body, tools = extractResponseTools(body)) {
  const parts = [];
  const instructions = responseContentPartToText(body.instructions);
  if (instructions.trim()) {
    parts.push(`system: ${instructions.trim()}`);
  }

  const toolPrompt = buildToolPrompt(tools);
  if (toolPrompt) {
    parts.push(toolPrompt);
  }

  if (typeof body.input === "string") {
    parts.push(`user: ${body.input.trim()}`);
  } else if (Array.isArray(body.input)) {
    parts.push(...body.input.map(responseInputItemToText).filter(Boolean));
  } else if (body.input && typeof body.input === "object") {
    const text = responseInputItemToText(body.input);
    if (text) parts.push(text);
  }

  return parts.join("\n\n");
}

function chatCompletionsToPrompt(body, tools = extractChatTools(body)) {
  const parts = [];
  const toolPrompt = buildToolPrompt(tools);
  if (toolPrompt) {
    parts.push(toolPrompt);
  }
  const messagePrompt = messagesToPrompt(body.messages);
  if (messagePrompt) {
    parts.push(messagePrompt);
  }
  return parts.join("\n\n");
}

function responsesSessionKeyFromBody(body) {
  const previous = body.previous_response_id;
  if (previous && state.responseSessions.has(previous)) {
    return state.responseSessions.get(previous);
  }
  return body.metadata?.session_id || body.session_id || body.user || "responses-default";
}

function rememberResponseSession(responseId, sessionKey) {
  state.responseSessions.set(responseId, sessionKey);
  if (state.responseSessions.size > 500) {
    const firstKey = state.responseSessions.keys().next().value;
    if (firstKey) state.responseSessions.delete(firstKey);
  }
}

function sessionKeyFromBody(body) {
  return body.user || body.metadata?.session_id || body.session_id || "default";
}

async function getDeepSeekSession(client, sessionKey) {
  const cached = state.chatSessions.get(sessionKey);
  if (cached?.sessionId) return cached;

  const session = await client.createChatSession();
  const next = {
    sessionId: session.chat_session_id,
    parentMessageId: null,
  };
  state.chatSessions.set(sessionKey, next);
  return next;
}

function sseWrite(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function sseEvent(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function sseDone(res) {
  res.write("data: [DONE]\n\n");
}

function makeResponseBase(responseId, model, status, output = []) {
  return {
    id: responseId,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status,
    model,
    output,
    parallel_tool_calls: false,
    tool_choice: "auto",
    tools: [],
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
    },
  };
}

function makeResponseMessageItem(itemId, status, text = "") {
  return {
    id: itemId,
    type: "message",
    status,
    role: "assistant",
    content:
      status === "completed"
        ? [
            {
              type: "output_text",
              text,
              annotations: [],
            },
          ]
        : [],
  };
}

function findToolSpec(name, tools) {
  const normalized = String(name || "").trim();
  if (!normalized) return null;
  return (
    tools.find((tool) => tool.wireName === normalized || tool.name === normalized) || {
      kind: "function",
      name: normalized,
      wireName: normalized,
    }
  );
}

function parseToolAttributes(raw = "") {
  const attrs = {};
  const quoted = /([:\w.-]+)\s*=\s*(["'])(.*?)\2/g;
  for (const match of raw.matchAll(quoted)) {
    attrs[match[1]] = match[3];
  }

  const unquoted = /([:\w.-]+)\s*=\s*([^\s"'=<>`]+)/g;
  for (const match of raw.matchAll(unquoted)) {
    if (!attrs[match[1]]) attrs[match[1]] = match[2];
  }
  return attrs;
}

function stripCodeFence(text) {
  const trimmed = String(text || "").trim();
  const fenced = trimmed.match(/^```[\w-]*\s*\n([\s\S]*?)\n?```$/);
  return fenced ? fenced[1].trim() : trimmed;
}

function parseJsonMaybe(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const opens = (text.match(/\{/g) || []).length;
    const closes = (text.match(/\}/g) || []).length;
    if (opens > closes) {
      try {
        return JSON.parse(`${text}${"}".repeat(opens - closes)}`);
      } catch {
        return null;
      }
    }
    return null;
  }
}

function extractFirstJsonObject(text) {
  const raw = String(text || "");
  const start = raw.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let quote = "";
  let escaped = false;

  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === quote) {
        inString = false;
        quote = "";
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      continue;
    }
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }

  return raw.slice(start);
}

function normalizeFunctionArguments(raw) {
  const cleaned = stripCodeFence(raw);
  if (!cleaned) return "{}";
  const parsed = parseJsonMaybe(cleaned);
  if (parsed && typeof parsed === "object") {
    if (parsed.parameters && typeof parsed.parameters === "object") {
      return JSON.stringify(parsed.parameters);
    }
    if (parsed.arguments && typeof parsed.arguments === "object") {
      return JSON.stringify(parsed.arguments);
    }
    return JSON.stringify(parsed);
  }
  return JSON.stringify({ input: cleaned });
}

function normalizeCustomInput(raw) {
  const cleaned = stripCodeFence(raw);
  const parsed = parseJsonMaybe(cleaned);
  if (parsed && typeof parsed === "object") {
    if (typeof parsed.input === "string") return parsed.input;
    if (typeof parsed.arguments?.input === "string") return parsed.arguments.input;
    if (typeof parsed.parameters?.input === "string") return parsed.parameters.input;
  }
  return cleaned;
}

function parseToolJsonObject(obj, tools) {
  if (!obj || typeof obj !== "object") return null;
  const name = obj.tool || obj.name || obj.function?.name;
  if (!name) return null;
  const spec = findToolSpec(name, tools);
  const rawArguments =
    obj.parameters ?? obj.arguments ?? obj.function?.arguments ?? (spec.kind === "custom" ? obj.input : {});
  return {
    spec,
    id: obj.id || obj.call_id || "",
    arguments:
      spec.kind === "custom"
        ? normalizeCustomInput(typeof rawArguments === "string" ? rawArguments : JSON.stringify(rawArguments ?? ""))
        : normalizeFunctionArguments(
            typeof rawArguments === "string" ? rawArguments : JSON.stringify(rawArguments ?? {}),
          ),
  };
}

function parseToolCallFromText(text, tools) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  const xml = raw.match(/<tool_call\b([^>]*)>([\s\S]*?)(?:<\/tool_call>|$)/i);
  if (xml) {
    const attrs = parseToolAttributes(xml[1]);
    const body = stripCodeFence(xml[2]);
    const parsedBody = parseJsonMaybe(body);
    const name = attrs.name || parsedBody?.tool || parsedBody?.name || parsedBody?.function?.name;
    if (!name) return null;
    const spec = findToolSpec(name, tools);
    return {
      spec,
      id: attrs.id || parsedBody?.id || parsedBody?.call_id || "",
      arguments: spec.kind === "custom" ? normalizeCustomInput(body) : normalizeFunctionArguments(body),
    };
  }

  const fenced = raw.match(/```(?:tool_json|json)\s*\n?([\s\S]*?)\n?```/i);
  if (fenced) {
    const parsed = parseJsonMaybe(fenced[1]);
    const call = parseToolJsonObject(parsed, tools);
    if (call) return call;
  }

  const parsed = parseJsonMaybe(raw);
  const directCall = parseToolJsonObject(parsed, tools);
  if (directCall) return directCall;

  const mentionedTool = tools.find((tool) => {
    const name = String(tool.wireName || tool.name || "").trim();
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return (
      name &&
      new RegExp(
        `(?:\\u8c03\\u7528|\\u4f7f\\u7528|call|use)\\s*(?:\\u5de5\\u5177\\s*)?${escapedName}`,
        "i",
      ).test(raw)
    );
  });
  if (mentionedTool) {
    const jsonText = extractFirstJsonObject(raw);
    const jsonObj = parseJsonMaybe(jsonText);
    const args =
      jsonObj && typeof jsonObj === "object" && !jsonObj.tool && !jsonObj.name && !jsonObj.function
        ? jsonObj
        : jsonObj?.arguments || jsonObj?.parameters || {};
    return {
      spec: mentionedTool,
      id: jsonObj?.id || jsonObj?.call_id || "",
      arguments:
        mentionedTool.kind === "custom"
          ? normalizeCustomInput(typeof args === "string" ? args : JSON.stringify(args ?? ""))
          : normalizeFunctionArguments(typeof args === "string" ? args : JSON.stringify(args ?? {})),
    };
  }

  return null;
}

function makeFunctionCallItem(itemId, status, callId, spec, argumentsText = "") {
  const item = {
    id: itemId,
    type: "function_call",
    status,
    call_id: callId,
    name: spec.name,
    arguments: argumentsText,
  };
  if (spec.namespace) {
    item.namespace = spec.namespace;
  }
  return item;
}

function makeCustomToolCallItem(itemId, status, callId, spec, input = "") {
  return {
    id: itemId,
    type: "custom_tool_call",
    status,
    call_id: callId,
    name: spec.name,
    input,
  };
}

function makeToolSearchCallItem(itemId, status, callId, argumentsText = "{}") {
  return {
    id: itemId,
    type: "tool_search_call",
    status,
    call_id: callId,
    execution: "client",
    arguments: parseJsonMaybe(argumentsText) || {},
  };
}

function makeToolCallItem(itemId, status, callId, toolCall, payload = "") {
  if (toolCall.spec.kind === "custom") {
    return makeCustomToolCallItem(itemId, status, callId, toolCall.spec, payload);
  }
  if (toolCall.spec.kind === "tool_search") {
    return makeToolSearchCallItem(itemId, status, callId, payload);
  }
  return makeFunctionCallItem(itemId, status, callId, toolCall.spec, payload);
}

function makeChatToolCall(toolCall) {
  const callId = toolCall.id || `call_ds_${Date.now()}`;
  const payload = toolCall.arguments || "{}";
  const item = {
    id: callId,
    type: "function",
    function: {
      name: toolCall.spec.name,
      arguments: payload,
    },
  };
  rememberToolCall({
    call_id: callId,
    name: toolCall.spec.name,
    type: "function_call",
  });
  return item;
}

function makeChatToolCallDelta(toolCall) {
  const callId = toolCall.id || `call_ds_${Date.now()}`;
  const payload = toolCall.arguments || "{}";
  rememberToolCall({
    call_id: callId,
    name: toolCall.spec.name,
    type: "function_call",
  });
  return [
    {
      index: 0,
      id: callId,
      type: "function",
      function: {
        name: toolCall.spec.name,
        arguments: payload,
      },
    },
  ];
}

function writeResponseToolCall(res, responseId, toolCall) {
  const itemIdPrefix = toolCall.spec.kind === "custom" ? "ctc" : "fc";
  const itemId = `${responseId}_${itemIdPrefix}`;
  const callId = toolCall.id || `call_ds_${Date.now()}`;
  const payload = toolCall.arguments || (toolCall.spec.kind === "custom" ? "" : "{}");
  const inProgressItem = makeToolCallItem(itemId, "in_progress", callId, toolCall, "");
  const completedItem = makeToolCallItem(itemId, "completed", callId, toolCall, payload);

  sseEvent(res, "response.output_item.added", {
    type: "response.output_item.added",
    output_index: 0,
    item: inProgressItem,
  });

  if (toolCall.spec.kind === "custom") {
    if (payload) {
      sseEvent(res, "response.custom_tool_call_input.delta", {
        type: "response.custom_tool_call_input.delta",
        item_id: itemId,
        output_index: 0,
        delta: payload,
      });
    }
    sseEvent(res, "response.custom_tool_call_input.done", {
      type: "response.custom_tool_call_input.done",
      item_id: itemId,
      output_index: 0,
      input: payload,
    });
  } else if (toolCall.spec.kind !== "tool_search") {
    if (payload) {
      sseEvent(res, "response.function_call_arguments.delta", {
        type: "response.function_call_arguments.delta",
        item_id: itemId,
        output_index: 0,
        delta: payload,
      });
    }
    sseEvent(res, "response.function_call_arguments.done", {
      type: "response.function_call_arguments.done",
      item_id: itemId,
      output_index: 0,
      arguments: payload,
    });
  }

  sseEvent(res, "response.output_item.done", {
    type: "response.output_item.done",
    output_index: 0,
    item: completedItem,
  });
  rememberToolCall(completedItem);
  return completedItem;
}

function writeResponseStart(res, responseId, model) {
  sseEvent(res, "response.created", {
    type: "response.created",
    response: makeResponseBase(responseId, model, "in_progress", []),
  });
  sseEvent(res, "response.in_progress", {
    type: "response.in_progress",
    response: makeResponseBase(responseId, model, "in_progress", []),
  });
}

function writeResponseTextStart(res, responseId) {
  const itemId = `${responseId}_msg`;
  sseEvent(res, "response.output_item.added", {
    type: "response.output_item.added",
    output_index: 0,
    item: makeResponseMessageItem(itemId, "in_progress"),
  });
  sseEvent(res, "response.content_part.added", {
    type: "response.content_part.added",
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    part: {
      type: "output_text",
      text: "",
      annotations: [],
    },
  });
  return itemId;
}

function writeResponseTextDone(res, responseId, text) {
  const itemId = `${responseId}_msg`;
  const item = makeResponseMessageItem(itemId, "completed", text);
  sseEvent(res, "response.output_text.done", {
    type: "response.output_text.done",
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    text,
  });
  sseEvent(res, "response.content_part.done", {
    type: "response.content_part.done",
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    part: {
      type: "output_text",
      text,
      annotations: [],
    },
  });
  sseEvent(res, "response.output_item.done", {
    type: "response.output_item.done",
    output_index: 0,
    item,
  });
  return item;
}

function writeResponseCompleted(res, responseId, model, output) {
  sseEvent(res, "response.completed", {
    type: "response.completed",
    response: makeResponseBase(responseId, model, "completed", output),
  });
}

async function runDeepSeekCompletion(body, options = {}) {
  const client = await makeDeepSeekClient();
  const sessionKey = sessionKeyFromBody(body);
  const session = await getDeepSeekSession(client, sessionKey);
  const model = body.model || CHAT_MODEL;
  const prompt = body.prompt || chatCompletionsToPrompt(body);

  if (!prompt.trim()) {
    throw new Error("没有可发送给 DeepSeek 的消息。");
  }

  const requestId = `chatcmpl-ds-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  pushLog(`发送到 DeepSeek Web：${prompt.slice(0, 60).replace(/\s+/g, " ")}`);

  const deepSeekStream = await client.chatCompletions({
    sessionId: session.sessionId,
    parentMessageId: session.parentMessageId,
    message: prompt,
    model,
    searchEnabled: Boolean(body.search_enabled),
    signal: options.signal,
  });

  let fullText = "";
  for await (const event of parseDeepSeekStream(deepSeekStream)) {
    if (event.type === "meta" && event.parentMessageId) {
      session.parentMessageId = event.parentMessageId;
      state.chatSessions.set(sessionKey, session);
      continue;
    }

    if (event.type !== "text" && event.type !== "reasoning") continue;
    const delta = event.delta || "";
    if (!delta) continue;
    fullText += delta;
    options.onEvent?.({ event, requestId, created, model, delta });
  }

  pushLog(`DeepSeek Web 回复完成：${fullText.length} 字符。`);
  return { requestId, created, model, content: fullText };
}

async function streamChatCompletions(res, body, options = {}) {
  const tools = extractChatTools(body);
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
  });

  const result = await runDeepSeekCompletion(body, {
    signal: options.signal,
    onEvent: ({ event, requestId, created, model, delta }) => {
      if (tools.length) {
        return;
      }
      sseWrite(res, {
        id: requestId,
        object: "chat.completion.chunk",
        created,
        model,
      choices: [
        {
          index: 0,
          delta:
            event.type === "reasoning"
              ? { reasoning_content: delta }
              : { content: delta },
          finish_reason: null,
        },
      ],
    });
    },
  });

  if (tools.length) {
    const toolCall = parseToolCallFromText(result.content, tools);
    if (toolCall) {
      sseWrite(res, {
        id: result.requestId,
        object: "chat.completion.chunk",
        created: result.created,
        model: result.model,
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: makeChatToolCallDelta(toolCall),
            },
            finish_reason: null,
          },
        ],
      });
      sseWrite(res, {
        id: result.requestId,
        object: "chat.completion.chunk",
        created: result.created,
        model: result.model,
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      });
      pushLog(`DeepSeek Web requested chat tool: ${toolCall.spec.name}`);
      sseDone(res);
      res.end();
      return;
    }
    if (result.content) {
      sseWrite(res, {
        id: result.requestId,
        object: "chat.completion.chunk",
        created: result.created,
        model: result.model,
        choices: [
          {
            index: 0,
            delta: { content: result.content },
            finish_reason: null,
          },
        ],
      });
    }
  }

  sseWrite(res, {
    id: result.requestId,
    object: "chat.completion.chunk",
    created: result.created,
    model: result.model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  });
  sseDone(res);
  res.end();
}

async function jsonChatCompletions(res, body) {
  const tools = extractChatTools(body);
  const result = await runDeepSeekCompletion({ ...body, stream: false });
  const toolCall = tools.length ? parseToolCallFromText(result.content, tools) : null;
  if (toolCall) {
    sendJson(res, 200, {
      id: result.requestId,
      object: "chat.completion",
      created: result.created,
      model: result.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [makeChatToolCall(toolCall)],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
    });
    pushLog(`DeepSeek Web requested chat tool: ${toolCall.spec.name}`);
    return;
  }

  sendJson(res, 200, {
    id: result.requestId,
    object: "chat.completion",
    created: result.created,
    model: result.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: result.content,
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  });
}

async function streamResponses(res, body, options = {}) {
  const model = body.model || CHAT_MODEL;
  const responseId = `resp_ds_${Date.now()}`;
  const tools = extractResponseTools(body);
  const prompt = responsesToPrompt(body, tools);
  const sessionKey = responsesSessionKeyFromBody(body);
  rememberResponseSession(responseId, sessionKey);

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
  });

  writeResponseStart(res, responseId, model);
  let textStarted = false;
  let fullText = "";

  await runDeepSeekCompletion(
    {
      model,
      prompt,
      stream: true,
      session_id: sessionKey,
      search_enabled: body.search_enabled,
    },
    {
      signal: options.signal,
      onEvent: ({ event, delta }) => {
        if (event.type !== "text" && event.type !== "reasoning") return;
        if (tools.length) {
          fullText += delta;
          return;
        }
        if (!textStarted) {
          writeResponseTextStart(res, responseId);
          textStarted = true;
        }
        fullText += delta;
        sseEvent(res, "response.output_text.delta", {
          type: "response.output_text.delta",
          item_id: `${responseId}_msg`,
          output_index: 0,
          content_index: 0,
          delta,
        });
      },
    },
  );

  const toolCall = tools.length ? parseToolCallFromText(fullText, tools) : null;
  let output = [];
  if (toolCall) {
    output = [writeResponseToolCall(res, responseId, toolCall)];
    pushLog(`DeepSeek Web requested tool: ${toolCall.spec.name}`);
  } else if (fullText) {
    if (!textStarted) {
      writeResponseTextStart(res, responseId);
      textStarted = true;
      sseEvent(res, "response.output_text.delta", {
        type: "response.output_text.delta",
        item_id: `${responseId}_msg`,
        output_index: 0,
        content_index: 0,
        delta: fullText,
      });
    }
    output = [writeResponseTextDone(res, responseId, fullText)];
  }
  writeResponseCompleted(res, responseId, model, output);
  sseDone(res);
  res.end();
}

async function jsonResponses(res, body) {
  const model = body.model || CHAT_MODEL;
  const responseId = `resp_ds_${Date.now()}`;
  const tools = extractResponseTools(body);
  const sessionKey = responsesSessionKeyFromBody(body);
  rememberResponseSession(responseId, sessionKey);
  const result = await runDeepSeekCompletion({
    model,
    prompt: responsesToPrompt(body, tools),
    stream: false,
    session_id: sessionKey,
    search_enabled: body.search_enabled,
  });

  const toolCall = tools.length ? parseToolCallFromText(result.content, tools) : null;
  if (toolCall) {
    const itemId = `${responseId}_${toolCall.spec.kind === "custom" ? "ctc" : "fc"}`;
    const callId = toolCall.id || `call_ds_${Date.now()}`;
    const item = makeToolCallItem(
      itemId,
      "completed",
      callId,
      toolCall,
      toolCall.arguments || (toolCall.spec.kind === "custom" ? "" : "{}"),
    );
    rememberToolCall(item);
    sendJson(res, 200, makeResponseBase(responseId, model, "completed", [item]));
    return;
  }

  sendJson(res, 200, makeResponseBase(responseId, model, "completed", [
    makeResponseMessageItem(`${responseId}_msg`, "completed", result.content),
  ]));
}

async function handleChatCompletions(req, res) {
  const body = await readJsonBody(req);
  if (body.stream !== false) {
    await streamChatCompletions(res, { ...body, stream: true });
    return;
  }
  await jsonChatCompletions(res, body);
}

async function handleResponses(req, res) {
  const body = await readJsonBody(req);
  if (body.stream !== false) {
    await streamResponses(res, body);
    return;
  }
  await jsonResponses(res, body);
}

async function handleChatTest(req, res) {
  const body = await readJsonBody(req);
  const message = String(body.message || "").trim();
  if (!message) {
    sendJson(res, 400, { ok: false, error: "请输入测试消息。" });
    return;
  }
  await streamChatCompletions(res, {
    model: body.model || CHAT_MODEL,
    stream: true,
    user: "ui-test",
    messages: [{ role: "user", content: message }],
  });
}

async function handleRequest(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/api/status") {
    sendJson(res, 200, await statusPayload());
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/events") {
    await handleSse(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/login") {
    await startLogin(res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/chat-test") {
    await handleChatTest(req, res);
    return;
  }

  if (req.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models")) {
    sendJson(res, 200, modelPayload());
    return;
  }

  if (
    req.method === "POST" &&
    (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions")
  ) {
    await handleChatCompletions(req, res);
    return;
  }

  if (req.method === "POST" && (url.pathname === "/v1/responses" || url.pathname === "/responses")) {
    await handleResponses(req, res);
    return;
  }

  if (req.method !== "GET") {
    sendJson(res, 405, { error: "method_not_allowed" });
    return;
  }

  if (url.pathname === "/favicon.ico") {
    res.writeHead(204, { "cache-control": "no-store" });
    res.end();
    return;
  }

  const filePath = safePublicPath(url.pathname);
  if (!filePath || !existsSync(filePath)) {
    notFound(res);
    return;
  }

  res.writeHead(200, {
    "content-type": contentTypeFor(filePath),
    "cache-control": "no-store",
  });
  createReadStream(filePath).pipe(res);
}

export async function startServer(port = Number(process.env.PORT || DEFAULT_UI_PORT)) {
  try {
    const creds = await readFile(AUTH_PATH, "utf8");
    if (creds) {
      pushLog("已找到本地保存的凭证。");
    }
  } catch {
    pushLog("还没有保存的凭证。");
  }

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      const message = error?.message || String(error);
      state.lastError = message;
      pushLog(message, "error");
      if (!res.headersSent) {
        sendJson(res, 500, { error: message });
      } else {
        try {
          sseWrite(res, { error: { message } });
          sseDone(res);
        } catch {
          // Ignore broken client connection.
        }
        res.end();
      }
    });
  });

  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  console.log(`DeepSeek 桥接器：http://127.0.0.1:${port}`);
  return server;
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  startServer().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
