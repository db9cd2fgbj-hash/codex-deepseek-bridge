const els = {
  statusBadge: document.querySelector("#statusBadge"),
  credentialState: document.querySelector("#credentialState"),
  capturedAt: document.querySelector("#capturedAt"),
  gatewayPort: document.querySelector("#gatewayPort"),
  modelsState: document.querySelector("#modelsState"),
  responsesHealth: document.querySelector("#responsesHealth"),
  authHealth: document.querySelector("#authHealth"),
  tokenPreview: document.querySelector("#tokenPreview"),
  tokenToggle: document.querySelector("#tokenToggle"),
  cookieBytes: document.querySelector("#cookieBytes"),
  authPath: document.querySelector("#authPath"),
  baseUrl: document.querySelector("#baseUrl"),
  codexBaseUrl: document.querySelector("#codexBaseUrl"),
  codexApiKey: document.querySelector("#codexApiKey"),
  codexModel: document.querySelector("#codexModel"),
  codexToml: document.querySelector("#codexToml"),
  copyToml: document.querySelector("#copyToml"),
  responsesState: document.querySelector("#responsesState"),
  toolCallingState: document.querySelector("#toolCallingState"),
  toolFunctionState: document.querySelector("#toolFunctionState"),
  toolCustomState: document.querySelector("#toolCustomState"),
  toolSearchState: document.querySelector("#toolSearchState"),
  toolStrategy: document.querySelector("#toolStrategy"),
  toolEvents: document.querySelector("#toolEvents"),
  loginButton: document.querySelector("#loginButton"),
  refreshButton: document.querySelector("#refreshButton"),
  logs: document.querySelector("#logs"),
  chatForm: document.querySelector("#chatForm"),
  chatInput: document.querySelector("#chatInput"),
  chatOutput: document.querySelector("#chatOutput"),
  sendButton: document.querySelector("#sendButton"),
  modelSelect: document.querySelector("#modelSelect"),
};

const seenLogIds = new Set();
const allLogs = [];
let statusCache = null;
let tokenVisible = false;
let activeLogFilter = "all";

function formatCapturedAt(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN");
}

function parsePort(baseUrl) {
  try {
    return new URL(baseUrl).port || "-";
  } catch {
    return "-";
  }
}

function gatewayToml(status) {
  const baseUrl = status.gateway?.baseUrl || "http://127.0.0.1:8787/v1";
  const apiKey = status.gateway?.apiKey || "deepseek";
  const model = status.gateway?.models?.[0] || "deepseek-web/deepseek-chat";
  return [
    'model_provider = "deepseek"',
    `model = "${model}"`,
    "",
    "[model_providers.deepseek]",
    'name = "deepseek"',
    `base_url = "${baseUrl}"`,
    'wire_api = "responses"',
    "requires_openai_auth = true",
    "",
    `api_key = "${apiKey}"`,
  ].join("\n");
}

function setBadge(status) {
  els.statusBadge.className = "badge";
  if (status.running) {
    els.statusBadge.textContent = "登录中";
    els.statusBadge.classList.add("busy");
    return;
  }
  if (status.credentials?.configured) {
    els.statusBadge.textContent = "已就绪";
    return;
  }
  els.statusBadge.textContent = "未登录";
  els.statusBadge.classList.add("missing");
}

function setLoginButton(status) {
  els.loginButton.disabled = Boolean(status.running);
  const label = els.loginButton.querySelector("span:last-child");
  if (status.running) {
    label.textContent = "等待登录";
  } else if (status.credentials?.configured) {
    label.textContent = "重新登录 / 刷新凭证";
  } else {
    label.textContent = "开始登录";
  }
}

function renderStatus(status) {
  statusCache = status;
  setBadge(status);
  setLoginButton(status);

  const credentials = status.credentials || {};
  const gateway = status.gateway || {};
  const toolCalling = gateway.toolCalling || {};

  els.credentialState.textContent = credentials.configured ? "已保存" : "未保存";
  els.capturedAt.textContent = formatCapturedAt(credentials.capturedAt);
  els.gatewayPort.textContent = parsePort(gateway.baseUrl);
  els.modelsState.textContent = gateway.models?.length ? "正常" : "-";
  els.responsesHealth.textContent = gateway.responsesEndpoint ? "正常" : "-";
  els.authHealth.textContent = credentials.configured ? "有效" : "待登录";
  els.tokenPreview.textContent = tokenVisible ? credentials.bearerPreview || "-" : "已隐藏";
  els.tokenToggle.textContent = tokenVisible ? "隐藏" : "显示";
  els.cookieBytes.textContent = credentials.cookieBytes ? `${credentials.cookieBytes} bytes` : "-";
  els.authPath.textContent = status.authPath || credentials.path || "-";
  els.baseUrl.textContent = gateway.baseUrl || "-";
  els.codexBaseUrl.textContent = gateway.baseUrl || "-";
  els.codexApiKey.textContent = gateway.apiKey || "deepseek";
  els.codexModel.textContent = gateway.models?.[0] || "deepseek-web/deepseek-chat";
  els.codexToml.textContent = gatewayToml(status);
  els.responsesState.textContent = gateway.responsesEndpoint || "/v1/responses";
  els.toolCallingState.textContent = toolCalling.enabled ? "已支持" : "未启用";
  els.toolFunctionState.textContent = `Function：${toolCalling.enabled ? "已支持" : "-"}`;
  els.toolCustomState.textContent = `Custom：${toolCalling.enabled ? "已支持" : "-"}`;
  els.toolSearchState.textContent = `Tool Search：${toolCalling.enabled ? "已支持" : "-"}`;
  els.toolStrategy.textContent =
    toolCalling.strategy === "prompt-xml-to-responses-events"
      ? "XML 转 Responses 事件"
      : toolCalling.strategy || "-";
  els.toolEvents.textContent = (toolCalling.events || []).join(" / ") || "-";
}

function logCategory(entry) {
  const message = entry.message || "";
  if (entry.level === "error" || /error|失败|断开|异常/i.test(message)) return "error";
  if (/tool|工具|function_call|custom_tool|tool_search|apply_patch/i.test(message)) return "tool";
  if (/DeepSeek|发送到|回复完成|requested/i.test(message)) return "deepseek";
  return "all";
}

function shouldShowLog(entry) {
  if (activeLogFilter === "all") return true;
  return logCategory(entry) === activeLogFilter;
}

function renderLogs() {
  els.logs.replaceChildren();
  const entries = allLogs.filter(shouldShowLog).slice(-120);
  for (const entry of entries) {
    const row = document.createElement("div");
    row.className = `log-entry ${entry.level === "error" ? "error" : ""}`;
    row.innerHTML = `<time></time><span></span>`;
    row.querySelector("time").textContent = entry.at || "";
    row.querySelector("span").textContent = entry.message || "";
    els.logs.append(row);
  }
  els.logs.scrollTop = els.logs.scrollHeight;
}

function appendLog(entry) {
  if (!entry || seenLogIds.has(entry.id)) return;
  seenLogIds.add(entry.id);
  allLogs.push(entry);
  if (allLogs.length > 240) allLogs.shift();
  renderLogs();
}

async function refreshStatus() {
  const res = await fetch("/api/status", { cache: "no-store" });
  const status = await res.json();
  renderStatus(status);
  for (const entry of status.recentLogs || []) appendLog(entry);
}

async function startLogin() {
  els.loginButton.disabled = true;
  const res = await fetch("/api/login", { method: "POST" });
  if (!res.ok && res.status !== 409) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "启动登录失败");
  }
  await refreshStatus();
}

function connectEvents() {
  const events = new EventSource("/api/events");
  events.onmessage = (event) => appendLog(JSON.parse(event.data));
  events.onerror = () =>
    appendLog({ id: Date.now(), level: "error", message: "日志连接断开，正在重连。" });
}

function clearEmptyState() {
  const empty = els.chatOutput.querySelector(".empty-state");
  if (empty) empty.remove();
}

function addBubble(role, text = "") {
  clearEmptyState();
  const bubble = document.createElement("article");
  bubble.className = `bubble ${role}`;
  const label = document.createElement("div");
  label.className = "bubble-label";
  label.textContent = role === "user" ? "你" : "DeepSeek";
  const body = document.createElement("div");
  body.className = "bubble-body";
  body.textContent = text;
  bubble.append(label, body);
  els.chatOutput.append(bubble);
  els.chatOutput.scrollTop = els.chatOutput.scrollHeight;
  return body;
}

function parseSseBlocks(text) {
  return text
    .split(/\n\n/)
    .map((block) =>
      block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6))
        .join("\n"),
    )
    .filter(Boolean);
}

function parseResponsesSse(text) {
  const events = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    if (!block.trim()) continue;
    let event = "message";
    const dataLines = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event: ")) event = line.slice(7);
      if (line.startsWith("data: ")) dataLines.push(line.slice(6));
    }
    const data = dataLines.join("\n");
    if (!data || data === "[DONE]") {
      events.push({ event: "[DONE]" });
      continue;
    }
    try {
      events.push({ event, data: JSON.parse(data) });
    } catch {
      events.push({ event, data });
    }
  }
  return events;
}

function responsesOutputItem(events) {
  for (const event of events) {
    if (event.event === "response.output_item.done" && event.data?.item) {
      return event.data.item;
    }
  }
  for (const event of events) {
    const item = event.data?.response?.output?.[0];
    if (item) return item;
  }
  return null;
}

async function sendChat(message) {
  if (!statusCache?.credentials?.configured) {
    throw new Error("请先完成 DeepSeek 登录。");
  }

  addBubble("user", message);
  const assistantBody = addBubble("assistant", "");
  els.sendButton.disabled = true;
  els.chatInput.disabled = true;

  const res = await fetch("/api/chat-test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      message,
      model: els.modelSelect.value,
    }),
  });

  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "DeepSeek 测试请求失败");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lastBreak = buffer.lastIndexOf("\n\n");
    if (lastBreak === -1) continue;

    const complete = buffer.slice(0, lastBreak + 2);
    buffer = buffer.slice(lastBreak + 2);

    for (const payload of parseSseBlocks(complete)) {
      if (payload.trim() === "[DONE]") continue;
      const parsed = JSON.parse(payload);
      if (parsed.error?.message) throw new Error(parsed.error.message);
      const choice = parsed.choices?.[0];
      const delta = choice?.delta?.content || choice?.delta?.reasoning_content || "";
      if (delta) {
        assistantBody.textContent += delta;
        els.chatOutput.scrollTop = els.chatOutput.scrollHeight;
      }
    }
  }
}

async function postResponses(body) {
  const res = await fetch("/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(text.slice(0, 300) || `HTTP ${res.status}`);
  return text;
}

async function runResponsesTextTest() {
  addBubble("user", "测试 /v1/responses 普通输出");
  const text = await postResponses({
    model: els.modelSelect.value,
    stream: false,
    input: "Reply exactly: responses ok",
  });
  const data = JSON.parse(text);
  const output = data.output?.[0]?.content?.[0]?.text || JSON.stringify(data.output?.[0] || data);
  addBubble("assistant", output);
}

async function runToolTest(kind) {
  const isCustom = kind === "custom";
  addBubble("user", isCustom ? "测试 Custom 工具事件" : "测试 Function 工具事件");
  const body = isCustom
    ? {
        model: els.modelSelect.value,
        stream: true,
        tools: [{ type: "custom", name: "apply_patch", description: "Apply a raw patch." }],
        input:
          "Use apply_patch to create TMP_UI_TEST.txt with text hello. Reply only with the tool call.",
      }
    : {
        model: els.modelSelect.value,
        stream: true,
        tools: [
          {
            type: "function",
            name: "shell_command",
            description: "Run a PowerShell command locally.",
            parameters: {
              type: "object",
              properties: {
                command: { type: "string" },
                workdir: { type: "string" },
              },
              required: ["command"],
            },
          },
        ],
        input: "Use shell_command to run Get-Location. Reply only with the tool call.",
      };
  const text = await postResponses(body);
  const events = parseResponsesSse(text);
  const item = responsesOutputItem(events);
  const eventNames = [...new Set(events.map((event) => event.event))].join("\n");
  addBubble(
    "assistant",
    [
      `工具事件：${item?.type || "未识别"}`,
      item?.name ? `工具名：${item.name}` : "",
      item?.arguments ? `参数：${item.arguments}` : "",
      item?.input ? `输入：${item.input.slice(0, 180)}` : "",
      "",
      eventNames,
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

async function runQuickTest(type) {
  if (type === "chat") {
    await sendChat("用一句话介绍你自己");
    return;
  }
  if (type === "responses") {
    await runResponsesTextTest();
    return;
  }
  await runToolTest(type);
}

async function copyText(text, button) {
  if (!text || text === "-") return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.left = "-999px";
    document.body.append(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
  if (button) {
    const old = button.textContent;
    button.textContent = "已复制";
    setTimeout(() => {
      button.textContent = old;
    }, 1200);
  }
}

document.querySelectorAll("[data-copy-target]").forEach((button) => {
  button.addEventListener("click", () => {
    const target = document.querySelector(`#${button.dataset.copyTarget}`);
    copyText(target?.textContent || "", button);
  });
});

document.querySelectorAll("[data-log-filter]").forEach((button) => {
  button.addEventListener("click", () => {
    activeLogFilter = button.dataset.logFilter || "all";
    document.querySelectorAll("[data-log-filter]").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    renderLogs();
  });
});

document.querySelectorAll("[data-quick-test]").forEach((button) => {
  button.addEventListener("click", () => {
    button.disabled = true;
    runQuickTest(button.dataset.quickTest)
      .catch((error) => {
        addBubble("assistant", `出错了：${error.message}`);
        appendLog({ id: Date.now(), level: "error", message: error.message });
      })
      .finally(() => {
        button.disabled = false;
      });
  });
});

els.copyToml.addEventListener("click", () => copyText(els.codexToml.textContent, els.copyToml));

els.tokenToggle.addEventListener("click", () => {
  tokenVisible = !tokenVisible;
  if (statusCache) renderStatus(statusCache);
});

els.loginButton.addEventListener("click", () => {
  startLogin().catch((error) => appendLog({ id: Date.now(), level: "error", message: error.message }));
});

els.refreshButton.addEventListener("click", () => {
  refreshStatus().catch((error) => appendLog({ id: Date.now(), level: "error", message: error.message }));
});

els.chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const message = els.chatInput.value.trim();
  if (!message) return;
  els.chatInput.value = "";
  sendChat(message)
    .catch((error) => {
      addBubble("assistant", `出错了：${error.message}`);
      appendLog({ id: Date.now(), level: "error", message: error.message });
    })
    .finally(() => {
      els.sendButton.disabled = false;
      els.chatInput.disabled = false;
      els.chatInput.focus();
    });
});

els.chatInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    els.chatForm.requestSubmit();
  }
});

connectEvents();
refreshStatus().catch((error) => appendLog({ id: Date.now(), level: "error", message: error.message }));
setInterval(refreshStatus, 3000);
