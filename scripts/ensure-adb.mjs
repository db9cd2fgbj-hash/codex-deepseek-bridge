#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import dgram from "node:dgram";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const exec = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (...args) => console.error("[adb-preflight]", ...args);

if (process.platform !== "android") {
  log("skip: bukan Android");
  process.exit(0);
}

const TCPIP_PORT = Number(process.env.ADB_TCPIP_PORT || 5555);
const CDP_PORT = Number(process.env.ADB_CDP_PORT || process.env.DEEPSEEK_CDP_PORT || 9223);
const CDP_SOCKET = process.env.ADB_CDP_SOCKET || "chrome_devtools_remote";
const CHROME_PACKAGE = process.env.ADB_CHROME_PACKAGE || "com.android.chrome";
const KEEP_WIRELESS = process.env.ADB_KEEP_WIRELESS_PORT === "1";
const SKIP_MDNS = process.env.ADB_SKIP_MDNS === "1";
const STATE_DIR = path.join(os.homedir(), ".adb-state");
const STATE_FILE = path.join(STATE_DIR, "state.json");
const SCAN_TIMEOUT_MS = Number(process.env.ADB_SCAN_TIMEOUT_MS || 90000);
const SCAN_CONCURRENCY = Number(process.env.ADB_SCAN_CONCURRENCY || 300);
const SCAN_START = Number(process.env.ADB_SCAN_START || 30000);
const SCAN_END = Number(process.env.ADB_SCAN_END || 65535);

async function adb(args, timeout = 15000) {
  try {
    const { stdout, stderr } = await exec("adb", args, { timeout, maxBuffer: 1 << 20 });
    return { ok: true, out: String(stdout || "").trim(), err: String(stderr || "").trim() };
  } catch (error) {
    return {
      ok: false,
      out: String(error?.stdout || "").trim(),
      err: String(error?.stderr || error?.message || error).trim(),
    };
  }
}

async function devices() {
  const result = await adb(["devices"]);
  return result.out
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [serial, state] = line.split(/\s+/);
      return { serial, state };
    })
    .filter((entry) => entry.serial && entry.state);
}

async function activeDevice() {
  return (await devices()).find((entry) => entry.state === "device") || null;
}

function localIPv4() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const entry of list || []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return "";
}

async function loadState() {
  try {
    return JSON.parse(await readFile(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

async function saveState(state) {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function verifyCdp() {
  try {
    const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return false;
    const info = await response.json();
    const pkg = String(info["Android-Package"] || "");
    if (pkg && !pkg.includes("chrome")) {
      log(`peringatan: CDP dimiliki ${pkg}, bukan Chrome`);
    }
    return true;
  } catch {
    return false;
  }
}

async function ensureForward(serial) {
  const result = await adb(
    ["-s", serial, "forward", `tcp:${CDP_PORT}`, `localabstract:${CDP_SOCKET}`],
    15000,
  );
  if (!result.ok) {
    log("gagal membuat forward:", result.err || result.out);
    return false;
  }
  if (!(await verifyCdp())) {
    log("membuka Chrome agar CDP aktif...");
    const started = await adb(
      [
        "-s",
        serial,
        "shell",
        "am",
        "start",
        "-n",
        `${CHROME_PACKAGE}/com.google.android.apps.chrome.Main`,
        "-a",
        "android.intent.action.VIEW",
        "-d",
        "https://chat.deepseek.com",
      ],
      15000,
    );
    if (!started.ok) log("am start gagal:", started.err || started.out);
    for (let attempt = 0; attempt < 20; attempt++) {
      if (await verifyCdp()) break;
      await sleep(500);
    }
  }
  if (await verifyCdp()) {
    log(`Chrome CDP siap di tcp:${CDP_PORT}`);
  } else {
    log(`forward tcp:${CDP_PORT} aktif, tetapi Chrome CDP belum merespons`);
  }
  return true;
}

async function tryConnect(address) {
  const result = await adb(["connect", address], 8000);
  const text = `${result.out}\n${result.err}`;
  if (!/connected/i.test(text)) return false;
  await sleep(400);
  const device = (await devices()).find((entry) => entry.serial === address && entry.state === "device");
  if (!device) return false;
  const check = await adb(["-s", address, "shell", "echo", "preflight-ok"], 6000);
  if (!check.out.includes("preflight-ok")) {
    await adb(["disconnect", address], 5000);
    return false;
  }
  return true;
}

function encodeName(name) {
  const labels = name
    .split(".")
    .filter(Boolean)
    .map((label) => {
      const buffer = Buffer.from(label);
      return Buffer.concat([Buffer.from([buffer.length]), buffer]);
    });
  return Buffer.concat([...labels, Buffer.from([0])]);
}

function buildQuery(names) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(names.length, 4);
  const questions = names.map((name) =>
    Buffer.concat([encodeName(name), Buffer.from([0, 12, 0x80, 0x01])]),
  );
  return Buffer.concat([header, ...questions]);
}

function parseName(buffer, start) {
  const labels = [];
  let offset = start;
  let next = start;
  let jumped = false;
  let guard = 0;
  while (offset < buffer.length && guard++ < 64) {
    const length = buffer[offset];
    if (length === 0) {
      offset += 1;
      if (!jumped) next = offset;
      break;
    }
    if ((length & 0xc0) === 0xc0) {
      if (offset + 1 >= buffer.length) break;
      const pointer = ((length & 0x3f) << 8) | buffer[offset + 1];
      if (!jumped) next = offset + 2;
      offset = pointer;
      jumped = true;
      continue;
    }
    if (offset + 1 + length > buffer.length) break;
    labels.push(buffer.subarray(offset + 1, offset + 1 + length).toString("latin1"));
    offset += 1 + length;
    if (!jumped) next = offset;
  }
  return { name: labels.join("."), next };
}

function parseRecords(buffer) {
  if (buffer.length < 12) return [];
  const questionCount = buffer.readUInt16BE(4);
  const recordCount =
    buffer.readUInt16BE(6) + buffer.readUInt16BE(8) + buffer.readUInt16BE(10);
  let offset = 12;
  for (let index = 0; index < questionCount; index++) {
    const question = parseName(buffer, offset);
    offset = question.next + 4;
    if (offset > buffer.length) return [];
  }
  const records = [];
  for (let index = 0; index < recordCount; index++) {
    const parsed = parseName(buffer, offset);
    offset = parsed.next;
    if (offset + 10 > buffer.length) break;
    const type = buffer.readUInt16BE(offset);
    const length = buffer.readUInt16BE(offset + 8);
    const dataOffset = offset + 10;
    if (dataOffset + length > buffer.length) break;
    const data = buffer.subarray(dataOffset, dataOffset + length);
    let value = null;
    if (type === 1 && length === 4) value = [...data].join(".");
    else if (type === 12) value = parseName(buffer, dataOffset).name;
    else if (type === 33 && length >= 6) {
      value = {
        port: data.readUInt16BE(4),
        target: parseName(buffer, dataOffset + 6).name,
      };
    }
    records.push({ name: parsed.name, type, value });
    offset = dataOffset + length;
  }
  return records;
}

function discoverMdns(timeoutMs = 4000) {
  return new Promise((resolve) => {
    const found = new Set();
    const addresses = new Map();
    const services = [];
    let socket;
    let done = false;
    let timer;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      for (const service of services) {
        const address = addresses.get(service.target.toLowerCase());
        if (address && service.port) found.add(`${address}:${service.port}`);
      }
      try {
        socket?.close();
      } catch {}
      resolve([...found]);
    };
    try {
      socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    } catch {
      resolve([]);
      return;
    }
    socket.on("error", finish);
    socket.on("message", (message, rinfo) => {
      const records = parseRecords(message);
      for (const record of records) {
        if (record.type === 1 && record.value) {
          addresses.set(record.name.toLowerCase(), record.value);
        }
        if (record.type === 33 && record.value) {
          services.push({ ...record.value, source: rinfo?.address || "" });
          const address = addresses.get(record.value.target.toLowerCase()) || rinfo?.address;
          if (address && record.value.port && /_adb/i.test(record.name)) {
            found.add(`${address}:${record.value.port}`);
          }
        }
      }
    });
    socket.bind(5353, () => {
      try {
        socket.addMembership("224.0.0.251");
      } catch {}
      for (const list of Object.values(os.networkInterfaces())) {
        for (const entry of list || []) {
          if (entry.family === "IPv4" && !entry.internal) {
            try {
              socket.addMembership("224.0.0.251", entry.address);
            } catch {}
          }
        }
      }
      const query = buildQuery(["_adb-tls-connect._tcp.local", "_adb._tcp.local"]);
      try {
        socket.send(query, 5353, "224.0.0.251");
      } catch {}
      setTimeout(() => {
        try {
          socket.send(query, 5353, "224.0.0.251");
        } catch {}
      }, 500);
    });
    timer = setTimeout(finish, timeoutMs);
  });
}

async function scanLoopback() {
  const deadline = Date.now() + SCAN_TIMEOUT_MS;
  let next = SCAN_START;
  let found = "";
  let queue = Promise.resolve();
  let scanned = 0;
  log(`scan loopback ${SCAN_START}-${SCAN_END} (maks ${Math.round(SCAN_TIMEOUT_MS / 1000)}s)...`);
  const testPort = (port) => {
    queue = queue.then(async () => {
      if (found) return;
      if (await tryConnect(`127.0.0.1:${port}`)) found = `127.0.0.1:${port}`;
    });
    return queue;
  };
  const probe = (port) =>
    new Promise((resolve) => {
      const socket = new net.Socket();
      let settled = false;
      const finish = (open) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(open);
      };
      socket.setTimeout(180, () => finish(false));
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
      socket.connect(port, "127.0.0.1");
    });
  const worker = async () => {
    while (!found && Date.now() < deadline && next <= SCAN_END) {
      const port = next++;
      scanned++;
      if (scanned % 5000 === 0) log(`scan ${port}/${SCAN_END}...`);
      if (await probe(port)) void testPort(port);
    }
  };
  await Promise.all(Array.from({ length: SCAN_CONCURRENCY }, worker));
  await Promise.race([queue, sleep(15000)]);
  return found;
}

async function fixFixedPort(serial) {
  if (KEEP_WIRELESS || !serial.includes(":")) return serial;
  const port = Number(serial.split(":").pop());
  if (port === TCPIP_PORT) return serial;
  log(`memindahkan adbd wireless ke port tetap ${TCPIP_PORT}...`);
  const result = await adb(["-s", serial, "tcpip", String(TCPIP_PORT)], 12000);
  if (!result.ok) {
    log("adb tcpip gagal:", result.err || result.out);
    return serial;
  }
  await sleep(2500);
  const candidates = [`127.0.0.1:${TCPIP_PORT}`];
  const ip = localIPv4();
  if (ip) candidates.push(`${ip}:${TCPIP_PORT}`);
  for (const address of candidates) {
    if (await tryConnect(address)) return address;
  }
  log("port tetap belum merespons; mencoba koneksi wireless lama...");
  if (await tryConnect(serial)) return serial;
  return serial;
}

async function main() {
  await adb(["start-server"], 20000);
  const state = await loadState();
  const ip = localIPv4();
  const candidates = [];
  const push = (address) => {
    if (address && !candidates.includes(address)) candidates.push(address);
  };

  push(`127.0.0.1:${TCPIP_PORT}`);
  if (ip) push(`${ip}:${TCPIP_PORT}`);
  push(state.device);
  if (state.port) {
    push(`127.0.0.1:${state.port}`);
    if (ip) push(`${ip}:${state.port}`);
  }

  let serial = "";

  const active = await activeDevice();
  if (active) {
    serial = active.serial;
    log(`sudah terhubung: ${serial}`);
  }

  for (const address of candidates) {
    if (serial) break;
    if (await tryConnect(address)) {
      serial = address;
      log(`terhubung via cache/fixed: ${address}`);
    }
  }

  if (!serial && !SKIP_MDNS) {
    const discovered = await discoverMdns();
    if (discovered.length) log("mDNS:", discovered.join(", "));
    for (const address of discovered) {
      if (serial) break;
      if (await tryConnect(address)) {
        serial = address;
        log(`terhubung via mDNS: ${address}`);
      }
    }
  }

  if (!serial) {
    const scanned = await scanLoopback();
    if (scanned) {
      serial = scanned;
      log(`terhubung via scan: ${scanned}`);
    }
  }

  if (!serial) {
    log("GAGAL: tidak ada perangkat adb. Buka Developer options > Wireless debugging");
    log("dan pastikan pairing masih aktif, lalu jalankan ulang.");
    process.exitCode = 1;
    return;
  }

  serial = await fixFixedPort(serial);
  if (!(await devices()).some((entry) => entry.serial === serial && entry.state === "device")) {
    const again = (await devices()).find((entry) => entry.state === "device");
    if (again) serial = again.serial;
  }

  if (!(await ensureForward(serial))) {
    process.exitCode = 1;
    return;
  }

  const port = serial.includes(":") ? Number(serial.split(":").pop()) : null;
  await saveState({
    device: serial,
    port,
    cdpPort: CDP_PORT,
    updatedAt: new Date().toISOString(),
  });
  log(`siap: device=${serial} cdp=tcp:${CDP_PORT} -> localabstract:${CDP_SOCKET}`);
}

await main().catch((error) => {
  log("ERROR:", error?.message || String(error));
  process.exitCode = 1;
});
