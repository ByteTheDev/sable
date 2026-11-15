/**
 * Headless screenshots of the running dev server, for visual checks when no display is
 * available. Uses the installed Edge (or Chrome) through playwright-core: no download.
 *
 *   node scripts/shot.mjs [--size 1280x800] [--url http://localhost:5174/] <steps...>
 *
 * Steps run in order:
 *   --wait 800                 pause (ms)
 *   --eval "js"                run in the page (async allowed; `sable` helpers exist in dev builds only)
 *   --click "css"   --hover "css"   --fill "css=>text"   --type "text"   --key "Enter"
 *   --shot out.png             full viewport        --shot "out.png@css"  one element
 *   --scale 2                  device scale factor (before the first step)
 *
 * Each run starts with a clean browser profile, so the app opens on the home screen.
 * Point it at a production build with SABLE_URL=http://localhost:<port>/ (only --wait/--shot/--click there).
 */
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

/** The dev server prefers 5173 and moves to 5174 when that is taken: use whichever answers. */
async function findServer() {
  if (process.env.SABLE_URL) return process.env.SABLE_URL;
  for (const port of [5173, 5174, 4173]) {
    try {
      const res = await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(1500) });
      if (res.ok && (await res.text()).includes('<title>Sable</title>')) return `http://localhost:${port}/`;
    } catch {
      /* not this one */
    }
  }
  throw new Error('No Sable dev server found on 5173/5174. Start it with "pnpm dev".');
}

const args = process.argv.slice(2);
let size = [1280, 800];
let url = await findServer();
let scale = 1;
const steps = [];
for (let i = 0; i < args.length; i += 2) {
  const key = args[i];
  const val = args[i + 1];
  if (key === '--size') size = val.split('x').map(Number);
  else if (key === '--url') url = val;
  else if (key === '--scale') scale = Number(val);
  else steps.push([key.replace(/^--/, ''), val]);
}

const candidates = [
  ['msedge', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'],
  ['msedge', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'],
  ['chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'],
];
const found = candidates.find(([, p]) => existsSync(p));
const browser = await chromium.launch({ headless: true, ...(found ? { executablePath: found[1] } : { channel: 'chrome' }) });
const context = await browser.newContext({ viewport: { width: size[0], height: size[1] }, deviceScaleFactor: scale, colorScheme: 'dark' });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 300)}`);
});

try {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  // Dev builds expose `sable`; production builds do not, so fall back to the DOM (shell drawn, boot loader gone).
  await page
    .waitForFunction(() => (window.sable ? window.sable.store.getState().ready : !!document.querySelector('.app') && !document.querySelector('.boot, .logo-intro')), null, { timeout: 30_000 })
    .catch(() => errors.push('app never became ready'));
  for (const [kind, val] of steps) {
    if (kind === 'wait') await page.waitForTimeout(Number(val));
    else if (kind === 'eval') {
      const out = await page.evaluate(`(async () => { ${val} })()`);
      if (out !== undefined) console.log('eval →', typeof out === 'string' ? out : JSON.stringify(out));
    } else if (kind === 'click') await page.click(val, { timeout: 8000 });
    else if (kind === 'hover') await page.hover(val, { timeout: 8000 });
    else if (kind === 'fill') {
      const [sel, text] = val.split('=>');
      await page.fill(sel, text, { timeout: 8000 });
    } else if (kind === 'type') await page.keyboard.type(val, { delay: 12 });
    else if (kind === 'key') await page.keyboard.press(val);
    else if (kind === 'shot') {
      const [file, sel] = val.split('@');
      mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
      if (sel) await page.locator(sel).first().screenshot({ path: file });
      else await page.screenshot({ path: file });
      console.log('shot →', file);
    } else console.log('unknown step', kind);
  }
} catch (err) {
  console.error('step failed:', err.message.split('\n')[0]);
  process.exitCode = 1;
} finally {
  if (errors.length) console.log([...new Set(errors)].slice(0, 12).join('\n'));
  await browser.close();
}
