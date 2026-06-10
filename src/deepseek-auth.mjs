import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(__dirname, "..");
export const DEFAULT_PORT = 9222;
export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
export const AUTH_DIR = path.join(ROOT_DIR, ".deepseek-auth");
export const AUTH_PATH = process.env.DEEPSEEK_AUTH_PATH || path.join(AUTH_DIR, "credentials.json");
export const PROFILE_DIR =
  process.env.DEEPSEEK_BROWSER_PROFILE || path.join(ROOT_DIR, ".deepseek-browser-profile");

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function emit(onProgress, message) {
  onProgress?.(message);
}

export function candidateBrowserPaths() {
  const localAppData = process.env.LOCALAPPDATA || "";
  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  return [
    path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
    localAppData ? path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe") : "",
    path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
    localAppData ? path.join(localAppData, "Microsoft", "Edge", "Application", "msedge.exe") : "",
  ].filter(Boolean);
}

export function findBrowserExecutable(explicitPath = "") {
  if (explicitPath) {
    if (!existsSync(explicitPath)) {
      throw new Error(`没有找到浏览器程序：${explicitPath}`);
    }
    return explicitPath;
  }
  const found = candidateBrowserPaths().find((entry) => existsSync(entry));
  if (!found) {
    throw new Error("没有找到 Chrome 或 Edge。可以用 --browser 指定浏览器路径。");
  }
  return found;
}

export async function isCdpReady(port = DEFAULT_PORT) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`);
    return res.ok;
  } catch {
    return false;
  }
}

export async function waitForCdp(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isCdpReady(port)) {
      return;
    }
    await sleep(500);
  }
  throw new Error(`等待 Chrome 调试端口超时：${port}`);
}

export async function launchBrowserIfNeeded(args = {}) {
  const port = args.port || DEFAULT_PORT;
  const onProgress = args.onProgress;
  if (await isCdpReady(port)) {
    emit(onProgress, `正在使用已有的浏览器调试端口：${port}`);
    return null;
  }
  if (args.attachOnly) {
    throw new Error(`没有浏览器调试端口正在监听：${port}`);
  }

  const browserPath = findBrowserExecutable(args.browser || "");
  await mkdir(PROFILE_DIR, { recursive: true });
  emit(onProgress, `正在启动浏览器：${browserPath}`);
  const child = spawn(
    browserPath,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${PROFILE_DIR}`,
      "--no-first-run",
      "--no-default-browser-check",
      "https://chat.deepseek.com",
    ],
    {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    },
  );
  child.unref();
  await waitForCdp(port, 30_000);
  return child;
}

async function cookiesToHeader(context) {
  const cookies = await context.cookies(["https://chat.deepseek.com", "https://deepseek.com"]);
  return {
    cookies,
    cookie: cookies.map((entry) => `${entry.name}=${entry.value}`).join("; "),
  };
}

function hasDeepSeekSession(cookieHeader) {
  return (
    cookieHeader.includes("d_id=") ||
    cookieHeader.includes("ds_session_id=") ||
    cookieHeader.includes("HWSID=") ||
    cookieHeader.includes("uuid=")
  );
}

async function readBearerFromLocalStorage(page) {
  try {
    const values = await page.evaluate(() => {
      const out = {};
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key) {
          out[key] = localStorage.getItem(key) || "";
        }
      }
      return out;
    });

    for (const [key, value] of Object.entries(values)) {
      const lower = key.toLowerCase();
      if (!lower.includes("token") && !lower.includes("auth")) {
        continue;
      }
      try {
        const parsed = JSON.parse(value);
        if (typeof parsed?.token === "string" && parsed.token.length > 20) {
          return parsed.token;
        }
        if (typeof parsed === "string" && parsed.length > 20) {
          return parsed;
        }
      } catch {
        if (typeof value === "string" && value.length > 20) {
          return value;
        }
      }
    }
  } catch {
    return "";
  }
  return "";
}

async function readBearerFromCurrentUser(page, cookieHeader) {
  try {
    const response = await page.request.get("https://chat.deepseek.com/api/v0/users/current", {
      headers: { Cookie: cookieHeader },
      timeout: 10_000,
    });
    if (!response.ok()) {
      return "";
    }
    const data = await response.json();
    const token = data?.data?.biz_data?.token;
    return typeof token === "string" ? token : "";
  } catch {
    return "";
  }
}

export async function saveCredentials(credentials) {
  await mkdir(path.dirname(AUTH_PATH), { recursive: true });
  await writeFile(AUTH_PATH, `${JSON.stringify(credentials, null, 2)}\n`, "utf8");
}

export async function readCredentials() {
  try {
    const raw = await readFile(AUTH_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function summarizeCredentials(credentials) {
  if (!credentials) {
    return {
      configured: false,
      path: AUTH_PATH,
    };
  }
  const bearer = typeof credentials.bearer === "string" ? credentials.bearer : "";
  const cookie = typeof credentials.cookie === "string" ? credentials.cookie : "";
  return {
    configured: Boolean(cookie && bearer),
    provider: credentials.provider || "deepseek-web",
    capturedAt: credentials.capturedAt || null,
    path: AUTH_PATH,
    cookieBytes: Buffer.byteLength(cookie, "utf8"),
    bearerPreview: bearer ? `${bearer.slice(0, 6)}...${bearer.slice(-6)}` : "",
    userAgent: credentials.userAgent || "",
  };
}

export async function runDeepSeekLogin(options = {}) {
  const port = Number(options.port || process.env.DEEPSEEK_CDP_PORT || DEFAULT_PORT);
  const timeoutMs = Number(
    options.timeoutMs || process.env.DEEPSEEK_LOGIN_TIMEOUT_MS || DEFAULT_TIMEOUT_MS,
  );
  const browserPath = options.browser || process.env.DEEPSEEK_BROWSER || "";
  const onProgress = options.onProgress;

  if (!Number.isFinite(port) || port <= 0) {
    throw new Error("CDP 端口无效。");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("登录超时时间无效。");
  }

  await launchBrowserIfNeeded({
    attachOnly: Boolean(options.attachOnly),
    port,
    browser: browserPath,
    onProgress,
  });

  const cdpUrl = `http://127.0.0.1:${port}`;
  emit(onProgress, `正在连接：${cdpUrl}`);
  const browser = await chromium.connectOverCDP(cdpUrl);
  let browserClosed = false;

  try {
    const context = browser.contexts()[0] || (await browser.newContext());
    let page = context.pages().find((entry) => entry.url().includes("chat.deepseek.com"));
    if (!page) {
      page = await context.newPage();
    }

    let capturedBearer = "";
    page.on("request", (request) => {
      const url = request.url();
      if (!url.includes("chat.deepseek.com/api/v0/")) {
        return;
      }
      const auth = request.headers().authorization;
      if (auth?.startsWith("Bearer ")) {
        capturedBearer = auth.slice("Bearer ".length);
        emit(onProgress, "已从请求头捕获 Bearer。");
      }
    });

    page.on("response", async (response) => {
      const url = response.url();
      if (!url.includes("/api/v0/users/current") || !response.ok()) {
        return;
      }
      try {
        const body = await response.json();
        const token = body?.data?.biz_data?.token;
        if (typeof token === "string" && token.length > 0) {
          capturedBearer = token;
          emit(onProgress, "已从用户信息响应捕获 Bearer。");
        }
      } catch {
        // Ignore non-JSON or body-read races.
      }
    });

    await page.goto("https://chat.deepseek.com", { waitUntil: "domcontentloaded" });
    await page.bringToFront();
    emit(onProgress, "请在打开的浏览器窗口中登录 DeepSeek。");

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const userAgent = await page.evaluate(() => navigator.userAgent).catch(() => "");
      const { cookies, cookie } = await cookiesToHeader(context);
      const sessionLooksValid = hasDeepSeekSession(cookie) || cookies.length > 3;

      if (!capturedBearer) {
        capturedBearer = await readBearerFromLocalStorage(page);
      }
      if (sessionLooksValid && !capturedBearer) {
        capturedBearer = await readBearerFromCurrentUser(page, cookie);
      }

      if (sessionLooksValid && capturedBearer && userAgent) {
        const credentials = {
          provider: "deepseek-web",
          cookie,
          bearer: capturedBearer,
          userAgent,
          capturedAt: new Date().toISOString(),
        };
        await saveCredentials(credentials);
        emit(onProgress, `凭证已保存到 ${AUTH_PATH}`);
        await browser.close();
        browserClosed = true;
        return credentials;
      }

      await sleep(2000);
    }

    throw new Error("登录超时：没有同时捕获到 cookie 和 bearer。");
  } finally {
    if (!browserClosed) {
      await browser.close().catch(() => {});
    }
  }
}
