/**
 * Watches a demo widget stream in, headless (no window), and measures what matters:
 *
 *   node scripts/widget-stream-check.mjs [--prompt "show me a latency chart"] [--size 1280x800] [--out scratch/genui]
 *
 * - every animation frame while it builds: the scroll position, the distance to the end, the
 *   widget block's height and top, its phase (wait, partial, final)
 * - screenshots at the skeleton, the first partial render, a later partial, the final render and
 *   during the reveal
 * - the time from "code complete" (the tool input arrives in the store) to the frame's final render
 *   being painted
 * - typing in the composer while it streams: long tasks over 50 ms, and the slowest key press
 *   (Event Timing), from the browser's own performance entries
 */
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const prompt = opt('prompt', 'show me a latency chart');
const [w, h] = opt('size', '1280x800').split('x').map(Number);
const out = opt('out', 'scratch/genui');
const tag = opt('tag', 'stream');
mkdirSync(out, { recursive: true });

async function findServer() {
  for (const port of [5173, 5174]) {
    try {
      const res = await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(1500) });
      if (res.ok && (await res.text()).includes('<title>Sable</title>')) return `http://localhost:${port}/`;
    } catch {
      /* next */
    }
  }
  throw new Error('No dev server');
}

const exe = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => existsSync(p));
const browser = await chromium.launch({ headless: true, ...(exe ? { executablePath: exe } : { channel: 'chrome' }) });
const page = await browser.newPage({ viewport: { width: w, height: h }, colorScheme: 'dark' });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 200)));

try {
  await page.goto(await findServer(), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.sable?.store.getState().ready, null, { timeout: 30_000 });

  // Instrument before anything streams.
  await page.evaluate(() => {
    const t = (window.__trace = { frames: [], longtasks: [], events: [], inputAt: 0, finalPaintAt: 0 });
    new PerformanceObserver((l) => l.getEntries().forEach((e) => t.longtasks.push({ start: e.startTime, dur: e.duration }))).observe({ type: 'longtask', buffered: true });
    try {
      new PerformanceObserver((l) => l.getEntries().forEach((e) => t.events.push({ name: e.name, dur: e.duration, start: e.startTime }))).observe({ type: 'event', durationThreshold: 16, buffered: true });
    } catch {}
    const store = window.sable.store;
    store.subscribe((s) => {
      if (t.inputAt) return;
      const id = s.ui.activeSessionId;
      const items = id ? s.data[id]?.items : null;
      if (!items) return;
      for (const k in items) {
        const it = items[k];
        if (it.type === 'tool' && it.kind === 'widget' && it.input) {
          t.inputAt = performance.now();
          return;
        }
      }
    });
    const tick = () => {
      const sc = document.querySelector('.tl-scroll');
      const box = document.querySelector('.gw-box');
      if (sc) {
        const r = box?.getBoundingClientRect();
        const phase = box?.getAttribute('data-phase') ?? null;
        t.frames.push({ at: performance.now(), top: sc.scrollTop, gap: Math.round(sc.scrollHeight - sc.clientHeight - sc.scrollTop), boxH: r ? Math.round(r.height) : null, boxTop: r ? Math.round(r.top) : null, phase, skel: !!document.querySelector('.gw-skel') });
        if (phase === 'final' && !t.finalPaintAt) requestAnimationFrame(() => (t.finalPaintAt = performance.now()));
      }
      if (t.frames.length < 20000) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  await page.evaluate((p) => window.sable.demo(p, { mode: 'bypassPermissions' }), prompt);

  const waitFor = (fn, timeout = 30_000) => page.waitForFunction(fn, null, { timeout, polling: 'raf' });
  const shots = [];
  const snap = async (name) => {
    const file = path.join(out, `${tag}-${name}.png`);
    await page.screenshot({ path: file });
    shots.push(file);
  };

  if (args.includes('--click-test')) {
    // sendPrompt: a real click inside the widget sends one message; a script calling it does not.
    await waitFor(() => document.querySelector('.gw-box[data-phase="final"]'));
    await waitFor(() => window.sable.store.getState().sessions[window.sable.store.getState().ui.activeSessionId]?.status === 'idle');
    const users = () => page.evaluate(() => {
      const s = window.sable.store.getState();
      return Object.values(s.data[s.ui.activeSessionId].items).filter((i) => i.type === 'user').map((i) => i.text);
    });
    const before = await users();
    const inner = page.frameLocator('.gw-iframe').frameLocator('iframe');
    // A script inside the widget calls sendPrompt with no click: refused.
    const innerFrame = page.frames().find((f) => f.url() === 'about:srcdoc');
    await innerFrame?.evaluate(() => window.sendPrompt('sent by a script, no click'));
    await page.waitForTimeout(400);
    const afterScript = await users();
    // A real mouse click on an option, then the submit button by keyboard (Playwright's pointer
    // actionability check misreads nested sandboxed frames for that one button; a key press is a
    // real user gesture too).
    await inner.locator('label:has-text("Sliding expiry")').click();
    await inner.locator('button.primary').focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(600);
    const afterClick = await users();
    await snap('click-sent');
    // A second attempt right away from a real mouse click, while the agent answers: refused (one at a time).
    const outer = await page.locator('.gw-iframe').boundingBox();
    await innerFrame.evaluate(() => document.body.addEventListener('click', () => window.sendPrompt('a second message while busy'), { once: true }));
    await page.mouse.click(outer.x + 30, outer.y + 20);
    await page.waitForTimeout(300);
    const afterSecond = await users();
    console.log(JSON.stringify({ before, afterScript, afterClick, afterSecond, toasts: await page.evaluate(() => window.sable.store.getState().toasts.map((t) => t.text)), errors }, null, 2));
    process.exit(0);
  }

  if (args.includes('--baseline')) {
    // The same typing during an ordinary streamed answer, for comparison.
    await waitFor(() => document.querySelector('.md[data-streaming]'));
    const t0 = await page.evaluate(() => performance.now());
    await page.click('.composer textarea.cmp-input:not(.cmp-mirror)', { timeout: 5000 }).catch(() => {});
    await page.keyboard.type('while this streams, the composer should stay quick to type into', { delay: 35 });
    const trace = await page.evaluate(() => window.__trace);
    const keys = trace.events.filter((e) => /key|input|beforeinput/.test(e.name) && e.start >= t0);
    console.log(JSON.stringify({ prompt, baseline: true, longTasksOver50ms: trace.longtasks.filter((l) => l.start >= t0 - 200 && l.dur > 50).map((l) => Math.round(l.dur)), slowestKeyEventMs: keys.length ? Math.round(Math.max(...keys.map((k) => k.dur))) : 0, keyEventsOver16ms: keys.length }, null, 2));
    process.exit(0);
  }
  await waitFor(() => document.querySelector('.gw-skel'));
  await snap('1-skeleton');
  // Type into the composer while the widget streams.
  const typing = (async () => {
    await page.click('.composer textarea.cmp-input:not(.cmp-mirror)', { timeout: 5000 }).catch(() => {});
    await page.keyboard.type('while this streams, the composer should stay quick to type into', { delay: 35 });
  })();
  await waitFor(() => document.querySelector('.gw-box[data-phase="partial"]'));
  await snap('2-partial');
  await page.waitForTimeout(450);
  await snap('3-partial-later');
  await waitFor(() => document.querySelector('.gw-box[data-phase="final"]'));
  await page.waitForTimeout(120);
  await snap('4-reveal');
  await typing;
  await page.waitForTimeout(1500);
  await snap('5-final');

  const trace = await page.evaluate(() => window.__trace);
  const building = trace.frames.filter((f) => f.boxH !== null && f.phase !== 'final');
  const heights = building.map((f) => f.boxH);
  let shrinks = 0;
  for (let i = 1; i < heights.length; i++) if (heights[i] < heights[i - 1] - 1) shrinks++;
  // While following the end, the gap to the end should stay near zero (the view holds the end).
  const gaps = building.map((f) => f.gap);
  const firstBuild = building[0]?.at ?? 0;
  const lastBuild = building[building.length - 1]?.at ?? 0;
  const longDuring = trace.longtasks.filter((l) => l.start >= firstBuild - 200 && l.start <= lastBuild + 1000);
  const keys = trace.events.filter((e) => /key|input|beforeinput/.test(e.name));
  console.log(
    JSON.stringify(
      {
        prompt,
        framesWhileBuilding: building.length,
        blockHeight: { first: heights[0], max: Math.max(...heights), last: heights[heights.length - 1], shrinksWhileBuilding: shrinks },
        endGapWhileBuilding: { max: Math.max(...gaps), median: gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)] },
        codeCompleteToFinalPaintMs: trace.inputAt && trace.finalPaintAt ? Math.round(trace.finalPaintAt - trace.inputAt) : null,
        longTasksOver50msDuringStream: longDuring
          .filter((l) => l.dur > 50)
          .map((l) => {
            const f = trace.frames.find((x) => x.at >= l.start) ?? trace.frames[trace.frames.length - 1];
            return `${Math.round(l.dur)} ms (${f?.phase ?? 'no widget'}${f?.skel ? ', skeleton' : ''}, +${Math.round(l.start - firstBuild)} ms)`;
          }),
        codeCompleteAt: trace.inputAt ? `+${Math.round(trace.inputAt - firstBuild)} ms` : null,
        slowestKeyEventMs: keys.length ? Math.round(Math.max(...keys.map((k) => k.dur))) : 0,
        keyEventsOver16ms: keys.length,
        shots,
        errors: [...new Set(errors)].slice(0, 8),
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
