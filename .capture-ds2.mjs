import { chromium } from 'playwright-core';
import fs from 'node:fs';
const OUT = '/data/data/com.termux/files/usr/tmp/opencode';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
const ctx = browser.contexts()[0];
for (const p of ctx.pages()) console.log('TAB', p.url().slice(0, 80), '|', await p.title().catch(()=>'?'));
const page = ctx.pages().find((p) => p.url().includes('c885fcf3')) || ctx.pages().find((p) => p.url().includes('chat.deepseek.com'));
await page.bringToFront();
const cdp = await ctx.newCDPSession(page);
await cdp.send('Network.enable', { maxPostDataSize: 1 << 20 });

const reqs = new Map();
const hits = [];
cdp.on('Network.requestWillBeSent', (e) => {
  const r = e.request;
  if (!r.url.includes('/api/')) return;
  const rec = { id: e.requestId, method: r.method, url: r.url.split('?')[0], headers: r.headers, postData: r.postData || null, status: null, extra: null };
  reqs.set(e.requestId, rec);
  if (r.url.includes('/chat/completion')) { hits.push(rec); console.log('>>> COMPLETION SENT'); }
});
cdp.on('Network.requestWillBeSentExtraInfo', (e) => {
  const rec = reqs.get(e.requestId);
  if (rec) rec.extra = e.headers;
});
cdp.on('Network.responseReceived', (e) => {
  const rec = reqs.get(e.requestId);
  if (rec) { rec.status = e.response.status; rec.mime = e.response.mimeType; if (rec.url.includes('completion')) console.log('<<< status', e.response.status, e.response.mimeType); }
});

const composer = page.locator('textarea[placeholder="Message DeepSeek"]').first();
await composer.click();
await page.keyboard.type('ping', { delay: 60 });
await page.waitForTimeout(500);
console.log('textarea value:', await composer.inputValue());
await page.keyboard.press('Enter');

const deadline = Date.now() + 120000;
while (Date.now() < deadline && !hits.some((h) => h.status)) await new Promise((r) => setTimeout(r, 1000));

fs.writeFileSync(`${OUT}/ds-capture2.json`, JSON.stringify({ hits, all: [...reqs.values()] }, null, 2));
for (const h of hits) {
  console.log('\n=== COMPLETION', h.method, h.status, h.url);
  for (const k of Object.keys(h.headers || {})) if (/authorization|pow|x-|content-type|referer|origin/i.test(k)) console.log(' ', k, '=', String(h.headers[k]).slice(0, 200));
  console.log(' postData:', (h.postData || '').slice(0, 800));
  if (h.extra) console.log(' cookie names:', Object.keys(h.extra).filter(k=>/cookie|waf/i.test(k)).join(', '));
}
if (!hits.length) console.log('NO COMPLETION. textarea now:', await composer.inputValue());
await page.close();
process.exit(0);
