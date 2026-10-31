# AGENTS.md

> Kontrak kerja untuk opencode CLI agent.
> Repo: `~/codex-deepseek-bridge`
> Baca SELURUH file ini sebelum menyentuh kode.
> Model gratis cenderung overreach. Dokumen ini membatasi ruang gerak.

## 0. Pre-flight (WAJIB SEBELUM MULAI)

1. Jalankan `git status`.
2. Jika ada file modified/untracked: **jangan revert apa pun**. Catat daftarnya.
3. Lanjut hanya jika instruksi task menyatakan "baseline dirty diizinkan".
   Jika tidak ada izin eksplisit: tulis `BLOCKED: working tree dirty` dan berhenti.
4. Jangan pernah `git checkout`, `git reset`, `git stash`, atau `git clean`
   untuk "merapikan" baseline.

## 1. Konteks Proyek

Proyek: bridge DeepSeek Web -> API OpenAI-compatible. Node.js, ESM, tanpa framework.
Environment: Android (Termux) -> `playwright-core` hanya jalan dengan preload.
Entry point: `src/server.mjs` (BUKAN root `server.mjs`).
Adapter protokol: `src/deepseek-web-client.mjs`.
Auth: `src/deepseek-auth.mjs`. PoW WASM: `src/deepseek-pow-wasm.mjs`.
Tujuan: memisahkan orkestrasi dari `src/server.mjs` **secara bertahap**
tanpa mengubah perilaku eksternal (endpoint, format SSE/JSON, header).

### Arsitektur Target (C4 Level 2)

```ascii
[Transport src/transport/ (HTTP/SSE, router, static)]
      -> [Orchestration src/orchestration/ (events, errors, session-store,
          auth-manager, pipeline, tool-loop)]
      -> [Adapter src/deepseek-web-client.mjs (PoW, header, payload)]
      -> [DeepSeek Web / Chrome via CDP]
```

Aturan panah (WAJIB):
- **Transport** hanya tahu HTTP/SSE. Tidak pernah memanggil adapter langsung.
- **Orchestration** tahu alur (Auth -> Session -> Stream -> Tools).
- **Adapter** satu-satunya yang bicara dengan DeepSeek Web / Chrome.
- Modul leaf (`events.mjs`, `errors.mjs`, `session-store.mjs`,
  `deepseek-pow-wasm.mjs`) tidak boleh mengimport modul proyek lain.
- Pelanggaran panah = bug arsitektur: laporkan, jangan perbaiki diam-diam.

## 2. Aturan Keras

### MUST
- Kerjakan **SATU task** per langkah. Jangan gabung dua task.
- Setelah tiap task, jalankan verifikasi yang tertulis di task itu.
- Jika verifikasi gagal: revert HANYA file task itu (dari backup/git), laporkan, berhenti.
- Pakai ESM (`import`/`export`).
- Pertahankan signature fungsi yang sudah dipakai `src/server.mjs`.
- File baru di `src/` (bukan root). Header komentar 1 baris berisi tujuan file.

### MUST NOT
- Mengubah `src/deepseek-pow-wasm.mjs`. Sama sekali.
- Mengubah `src/deepseek-auth.mjs` atau `src/deepseek-web-client.mjs`
  kecuali task secara eksplisit menyuruh.
- Menambah dependency (`npm install`, import package baru).
- Refactor "sekalian" file yang tidak disebut di task.
- Mengubah nama endpoint, format SSE, atau field JSON response.
- Menghapus kode lama sebelum task yang menyuruh menghapus.
- Menyentuh `.deepseek-auth/`, `.deepseek-browser-profile/`, atau file biner.
- Menebak. Kalau ambigu: berhenti dan tulis pertanyaan.

### Jika ragu
Berhenti. Tulis: `BLOCKED: <pertanyaan spesifik>`. Jangan improvisasi.

## 3. Verifikasi Standar (Termux / Android)

Tidak ada test suite. Verifikasi per task:

```bash
# 1. syntax check (wajib untuk tiap file yang dibuat/diubah)
node --check <path-file>

# 2. smoke start + endpoint (jalankan dari root repo)
TMP="${TMPDIR:-$HOME/.cache}/ds-smoke"; mkdir -p "$TMP"
PORT="${PORT:-8787}"
timeout 20 node --require ./src/android-preload.cjs src/server.mjs > "$TMP/server.log" 2>&1 &
SRV=$!
for i in $(seq 1 40); do
  curl -sf -m 1 "http://127.0.0.1:$PORT/api/status" >/dev/null && break
  sleep 0.5
done
curl -s -m 5 "http://127.0.0.1:$PORT/api/status" | head -c 200; echo
curl -s -m 5 "http://127.0.0.1:$PORT/v1/models"  | head -c 200; echo
kill "$SRV" 2>/dev/null
wait "$SRV" 2>/dev/null
tail -5 "$TMP/server.log"
```

Task lulus jika: syntax OK, server start tanpa stack trace, kedua curl
mengembalikan JSON valid (bukan HTML error, bukan koneksi ditolak).

Catatan: JANGAN memakai `node src/server.mjs` tanpa `--require ./src/android-preload.cjs`
(pasti gagal: `Unsupported platform: android`).

Jika langkah 2 gagal: baca stack trace, perbaiki HANYA file yang baru
diubah. Jangan menyentuh file lain untuk "menutupi" error.

## 4. Urutan Task (kerjakan berurutan, jangan lompat)

---

Task 1 — src/orchestration/errors.mjs

Buat: `src/orchestration/errors.mjs` (leaf, tanpa import proyek).

```js
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
  // constructor(code, message, { phase, retryable, cause })
  // simpan: this.code, this.phase, this.retryable, this.cause
}
export function isRetryable(code) { /* return boolean berdasarkan peta */ }
```

Verify: `node --check src/orchestration/errors.mjs`
Acceptance:
- `new BridgeError("auth_expired", "x").code === "auth_expired"`.
- `instanceof Error` true.
- Tidak ada `import`.

---

Task 2 — src/orchestration/events.mjs

Buat: `src/orchestration/events.mjs` (leaf, tanpa import).
Event wajib membawa konteks `ctx` = `{ requestId, created, model }`:

```js
export const evPhase     = (ctx, phase) => ({ type: "phase", ctx, phase });
export const evMeta      = (ctx, parentMessageId) => ({ type: "meta", ctx, parentMessageId });
export const evText      = (ctx, delta) => ({ type: "text_delta", ctx, delta });
export const evReasoning = (ctx, delta) => ({ type: "reasoning_delta", ctx, delta });
export const evToolStart = (ctx, callId, name, kind) => ({ type: "tool_call_start", ctx, callId, name, kind });
export const evToolArgs  = (ctx, callId, delta) => ({ type: "tool_call_args_delta", ctx, callId, delta });
export const evToolDone  = (ctx, callId, payload) => ({ type: "tool_call_done", ctx, callId, payload });
export const evDone      = (ctx, status) => ({ type: "done", ctx, status });
export const evError     = (ctx, code, message, retryable = false) => ({ type: "error", ctx, code, message, retryable });
```

Verify: `node --check src/orchestration/events.mjs`
Acceptance: tiap export arrow function; tidak ada `console.*`.

---

Task 3 — src/transport/sse-writer.mjs

Buat: `src/transport/sse-writer.mjs`.
Pindahkan apa adanya dari `src/server.mjs`: `sseWrite`, `sseEvent`, `sseDone`
(saat ini di sekitar baris 491-503). Jangan ubah isi, jangan rename.

Ubah `src/server.mjs`:
```js
import { sseWrite, sseEvent, sseDone } from "./transport/sse-writer.mjs";
```
Hapus definisi lokalnya. Jangan ubah import lain.

Verify: syntax `src/server.mjs` + smoke + `curl /v1/models`.
Acceptance:
- `grep -n "function sseWrite" src/server.mjs` -> kosong.
- `grep -n "sseWrite" src/server.mjs` -> masih ada (via import).
- `/v1/models` tetap JSON valid.

---

Task 4 — src/orchestration/session-store.mjs

Buat: `src/orchestration/session-store.mjs`.

```js
export function createSessionStore({ ttlMs = 30 * 60 * 1000 } = {}) {
  // return { get(key), set(key, value), delete(key), invalidateAll(), size() }
  // TTL dicek saat get; expired -> undefined + auto-delete
}
```

Ubah `src/server.mjs`:
- Hapus `chatSessions: new Map()` dari `state`.
- Buat `const chatSessions = createSessionStore();` di module scope.
- Ganti semua `state.chatSessions.get/set` -> `chatSessions.get/set`.
- `getDeepSeekSession` tetap mengembalikan objek yang sama.

Jangan sentuh `state.responseSessions`.

Verify: syntax + smoke + `curl /api/status`.
Acceptance:
- `grep -rn "state.chatSessions" src/` -> kosong.
- `/api/status` JSON valid.
- Tidak ada error start.

---

Task 5 — src/orchestration/auth-manager.mjs

Buat: `src/orchestration/auth-manager.mjs`.

```js
export function createAuthManager({ loadCredentials, createClient }) {
  // return { async getClient(signal), invalidate() }
}
```

Perilaku:
- `getClient()` pertama: `loadCredentials()`, buat client, simpan.
- Panggilan bersamaan saat cache kosong: hanya satu yang load; sisanya menunggu Promise yang sama.
- Jangan cache kegagalan (rejection harus dibuang dari cache).
- `invalidate()`: kosongkan cache.

Ubah `src/server.mjs`:
- `makeDeepSeekClient` mendelegasikan ke `authManager.getClient()`.
- Pesan error tetap: `还没有 DeepSeek 登录凭证，请先登录。`
- Di `startLogin`, pada `.then(() => { ... })` setelah login sukses (sekitar baris 145),
  panggil `authManager.invalidate()` agar client di-rebuild dengan credentials baru.

Jangan ubah `src/deepseek-auth.mjs` atau `readCredentials`.

Verify: syntax + smoke + `curl /api/status`.
Acceptance:
- `makeDeepSeekClient` masih ada dan dipanggil di tempat yang sama.
- Dua pemanggilan `makeDeepSeekClient` berturut-turut tidak error.
- Tidak ada error start.

---

Task 6 — bersihkan src/server.mjs

Ubah `src/server.mjs` saja.
- Import rapi dari `./transport/` dan `./orchestration/`.
- Hapus helper yang sudah tidak dipakai (cek dengan grep).
- Jangan pindahkan logika lain.

Jangan pindahkan `parseToolCallFromText`, `writeResponseTextStart`, atau
fungsi format OpenAI. Itu task berikut.

Verify: smoke + ketiga curl.
Acceptance:
- `node --check src/server.mjs` OK.
- Server start, endpoint OK.
- Tidak ada import yang tidak terpakai.

---

Task 7 — src/orchestration/pipeline.mjs (chat completions saja)

Buat: `src/orchestration/pipeline.mjs`.

```js
export function createPipeline({ authManager, sessionStore }) {
  // return { async *runChatCompletion(normalized, ctx, signal) { ... } }
}
```

- Yield event internal dari `events.mjs`. Jangan menulis ke `res`.
- Panggil `authManager.getClient()`, `sessionStore.get/set`,
  `client.chatCompletions`, `parseDeepSeekStream`.

Ubah `src/server.mjs`:
- `streamChatCompletions`: setup SSE -> iterasi pipeline -> petakan event ke
  payload SSE OpenAI -> `sseDone`.
- **Pertahankan perilaku**: jika `tools.length > 0`, buffer semua teks dulu dan
  emit `tool_calls` di akhir (seperti kode asli). Jangan ubah jadi streaming delta.
- Pemetaan event -> SSE OpenAI identik dengan sebelumnya; gunakan `ctx`
  untuk `id`, `created`, `model`.

Jangan sentuh `streamResponses` / `/v1/responses`.

Verify: smoke + `/v1/models` + satu `POST /api/chat-test` body `{"message":"hi"}`
(boleh gagal auth, yang penting 500 JSON, bukan crash).
Acceptance:
- `streamChatCompletions` tidak memanggil `client.chatCompletions` langsung.
- Event ke klien identik dengan sebelum task.
- Server tetap start.

---

Task 8 — satukan JSON chat lewat pipeline

Ubah `src/server.mjs` saja.
- `jsonChatCompletions` konsumsi `pipeline.runChatCompletion` yang sama:
  agregasi `text_delta` jadi satu string, kumpulkan `tool_call_done`.
- Hapus `runDeepSeekCompletion` HANYA dari jalur chat completion.
- `runDeepSeekCompletion` masih dipakai `streamResponses`/`jsonResponses`:
  biarkan fungsinya ada.

Jangan sentuh `streamResponses` / `jsonResponses`.

Verify: smoke + `/v1/models` + `POST /v1/chat/completions` dengan `"stream": false`
(boleh 500 auth, tapi JSON valid).
Acceptance:
- `grep -n "runDeepSeekCompletion" src/server.mjs` -> hanya di area `/v1/responses`.
- `grep -n "client.chatCompletions" src/server.mjs` -> kosong.
- Shape JSON mode non-stream sama.

---

Task 9 — src/orchestration/tool-loop.mjs

Buat: `src/orchestration/tool-loop.mjs`.

```js
export async function* runToolLoop({ pipeline, normalized, tools, budget = 8, ctx, signal }) { /* ... */ }
```

- Minimal: panggil `pipeline.runChatCompletion` sekali, teruskan semua event,
  dan jika ada `tool_call_done` yield juga.
- Loop multi-langkah boleh, tapi harus dijaga `budget`.
- Jika ragu: versi 1-langkah dulu + komentar `// TODO(task 9b): multi-step`.

Ubah `src/server.mjs`: `streamChatCompletions` memakai `runToolLoop` untuk
jalur yang punya tools. Jalur tanpa tools tetap langsung ke pipeline.

Jangan pindahkan `parseToolCallFromText` (biarkan di `src/server.mjs`).

Verify: smoke + `/v1/models`.
Acceptance:
- `grep -n "runToolLoop" src/server.mjs` -> minimal 1 pemakaian.
- Tidak ada duplikasi logika tools.
- Server start.

---

Task 10 — /v1/responses lewat pipeline

Ubah `src/server.mjs` saja.
- Ganti `runDeepSeekCompletion` di `streamResponses` dan `jsonResponses`
  dengan pipeline (+ `runToolLoop` bila ada tools).
- Pertahankan format SSE Responses API sama persis
  (`response.created`, `response.output_text.delta`, dst).
- Hapus `runDeepSeekCompletion` sepenuhnya jika sudah tidak dipakai.

Jangan ubah nama event SSE.

Verify: smoke + `/v1/models` + `POST /v1/responses` `"stream": true`
(boleh 500 auth, yang penting `response.created` terkirim sebelum error).
Acceptance:
- `grep -n "runDeepSeekCompletion" src/` -> kosong.
- Event SSE Responses API sama.
- Server start.

---

Task 11 — (Opsional, hanya jika diminta) responseSessions

Buat store serupa `session-store.mjs` untuk `responseSessions`, ganti
`state.responseSessions` di `src/server.mjs`, lalu hapus dari `state`.

---

## 5. Format Laporan Akhir Tiap Task

```
TASK <n>: <lulus|gagal|blocked>
FILES: <list file yang dibuat/diubah>
VERIFY:
  - node --check: <ok|fail>
  - smoke start: <ok|fail>
  - curl: <ok|fail>
CATATAN: <1-3 baris, atau "-">
```

Jika gagal: tambahkan `ROLLBACK: <file yang di-revert>`.
Jika blocked: tambahkan `BLOCKED: <pertanyaan>`.

## 6. Definition of Done (seluruh proyek)

- `src/server.mjs` tidak memanggil `client.chatCompletions` langsung.
- Tidak ada `state.chatSessions` di `src/server.mjs`
  (`state.responseSessions` hanya jika Task 11 dikerjakan).
- `runDeepSeekCompletion` tidak ada.
- `src/orchestration/` berisi: `errors`, `events`, `session-store`,
  `auth-manager`, `pipeline`, `tool-loop`.
- `src/transport/sse-writer.mjs` ada dan dipakai `src/server.mjs`.
- Semua endpoint lama jalan: status, models, chat, responses, chat-test, login.
- `src/deepseek-pow-wasm.mjs`, `src/deepseek-auth.mjs`,
  `src/deepseek-web-client.mjs` tidak berubah (cek `git diff`).

## 7. Kalau Stuck

1. `git status` dan `git diff` dulu.
2. Baca ulang task yang sedang dikerjakan.
3. Jika error dari file di luar task: jangan diperbaiki, laporkan `BLOCKED`.
4. Jika error dari file task: revert file itu, coba sekali lagi dengan
   pendekatan lebih kecil.
5. Masih gagal: revert, tulis `BLOCKED: <ringkasan>`, berhenti.
