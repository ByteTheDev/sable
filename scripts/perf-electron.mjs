/**
 * Frame and CPU measurements in a real Electron window (the built app: run `pnpm desktop:build` first).
 *
 *   node scripts/perf-electron.mjs [label] [--size 960x640] [--json out.json]
 *
 * This opens a VISIBLE window (frame timings need one that is really shown): by default 960x640 in
 * the top-left corner of the work area, never maximised or fullscreen, never on top, opened without
 * taking focus. `--size` is clamped to the display's work area, so the window cannot cover the
 * taskbar or the whole screen. Run it only when nobody is working on the machine, and compare runs
 * only at the same size.
 *
 * Starts `electron .` with its own temporary SABLE_USER_DATA and SABLE_HOME, the Demo agent and
 * SABLE_PERF=1 (debug helpers in the page, the window opens without taking focus, focus is emulated
 * so the page behaves as the foreground window). Runs a fixed walk: idle home, pointer sweeps over the
 * sidebar and composer, menus, typing, a streaming Demo answer, scrolling a long transcript, an idle
 * session. For each step: frame deltas (rAF), missed frames, long tasks, slow input events (Event
 * Timing), main-thread time (CDP Performance metrics) and CPU per process type (app.getAppMetrics).
 * Never sends from the composer with Claude or Codex; everything runs on the Demo agent. Kills what it
 * starts and deletes its temporary folders.
 */
import { _electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const electronPath = require('electron');

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const label = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'run';
// Small by default: 1600x1000 was larger than a 1536x960 laptop screen and covered it, taskbar included.
const [W, H] = opt('size', '960x640').split('x').map(Number);
const jsonOut = opt('json');
/** --ablate: instead of the walk, repeat a sidebar sweep and an idle spell with parts switched off by CSS. */
const ablate = argv.includes('--ablate');
/** --trace: also record a 5 s trace while the long Demo answer streams and print where the renderer's time went. */
const traceRun = argv.includes('--trace');

const tmp = mkdtempSync(path.join(os.tmpdir(), 'sable-perf-'));
const userData = path.join(tmp, 'ud');
const home = path.join(tmp, 'home');
mkdirSync(userData, { recursive: true });
mkdirSync(home, { recursive: true });
// The window first opens small in the top-left corner (the shell accepts nothing under 900x600) and
// is then given the asked size, clamped to the work area, once the display is known.
writeFileSync(path.join(userData, 'window-state.json'), JSON.stringify({ x: 0, y: 0, width: Math.max(900, Math.min(W, 960)), height: Math.max(600, Math.min(H, 640)) }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const app = await _electron.launch({
  executablePath: electronPath,
  args: [root],
  cwd: root,
  env: { ...process.env, SABLE_USER_DATA: userData, SABLE_HOME: home, SABLE_DEMO: '1', SABLE_PERF: '1' },
  timeout: 60_000,
});

const results = [];
try {
  const page = await app.firstWindow({ timeout: 90_000 });
  await page.waitForFunction(() => window.sable?.store.getState().ready, null, { timeout: 60_000 });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await cdp.send('Performance.enable');
  const gpu = await app.evaluate(({ app }) => app.getGPUFeatureStatus());
  console.log('gpu:', JSON.stringify({ gpu_compositing: gpu.gpu_compositing, rasterization: gpu.rasterization, canvas: gpu['2d_canvas'], webgl: gpu.webgl }));
  // The window was opened without focus; with focus emulated, tell the page it has it.
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const bounds = await app.evaluate(({ BrowserWindow, screen }, [w, h]) => {
    const win = BrowserWindow.getAllWindows()[0];
    const area = screen.getDisplayMatching(win.getBounds()).workArea;
    const b = { x: area.x, y: area.y, width: Math.min(w, area.width), height: Math.min(h, area.height) };
    if (win.isMaximized()) win.unmaximize();
    win.setFullScreen(false);
    win.setAlwaysOnTop(false);
    win.setBounds(b);
    return b;
  }, [W, H]);
  console.log(`window: ${bounds.width}x${bounds.height} at ${bounds.x},${bounds.y}${bounds.width !== W || bounds.height !== H ? ` (asked for ${W}x${H}, clamped to the work area)` : ''}`);

  // Skip the welcome, keep everything on the Demo agent, never start a Claude process early.
  await page.evaluate(async () => {
    await window.sable.actions.setSettings({ onboarded: true, prewarm: false });
    window.sable.store.getState().setUi({ homeProvider: 'demo' });
  });
  await page.waitForSelector('.home', { timeout: 20_000 });
  await sleep(2500);

  // The recorder: rAF deltas, long tasks, long animation frames, slow input events.
  await page.evaluate(() => {
    const st = { on: false, deltas: [], last: 0, long: [], loaf: 0, events: [] };
    // Only while recording frames: a running rAF loop would itself keep the page drawing.
    const loop = (t) => {
      if (!st.on || !st.frames) return;
      if (st.last) st.deltas.push(t - st.last);
      st.last = t;
      requestAnimationFrame(loop);
    };
    new PerformanceObserver((l) => st.on && l.getEntries().forEach((e) => st.long.push(e.duration))).observe({ type: 'longtask', buffered: false });
    try {
      new PerformanceObserver((l) => st.on && l.getEntries().forEach((e) => (st.loaf += e.blockingDuration || 0))).observe({ type: 'long-animation-frame', buffered: false });
    } catch {}
    new PerformanceObserver((l) => st.on && l.getEntries().forEach((e) => st.events.push([e.name, e.duration, e.processingEnd - e.processingStart, e.processingStart - e.startTime]))).observe({ type: 'event', durationThreshold: 16, buffered: false });
    window.__perf = {
      start(frames = true) {
        Object.assign(st, { on: true, frames, deltas: [], last: 0, long: [], loaf: 0, events: [] });
        if (frames) requestAnimationFrame(loop);
      },
      stop() {
        st.on = false;
        const d = st.deltas.slice().sort((a, b) => a - b);
        const q = (p) => (d.length ? d[Math.min(d.length - 1, Math.floor(p * d.length))] : 0);
        const ev = st.events.map((e) => e[1]).filter((x) => x > 50).sort((a, b) => a - b);
        return {
          frames: d.length,
          p50: q(0.5),
          p95: q(0.95),
          p99: q(0.99),
          max: d[d.length - 1] ?? 0,
          missed: d.filter((x) => x > 25).length,
          longTasks: st.long.length,
          longMs: st.long.reduce((a, b) => a + b, 0),
          loafBlock: st.loaf,
          slowEvents: ev.length,
          eventMax: ev[ev.length - 1] ?? 0,
          eventWorst: st.events.sort((a, b) => b[1] - a[1]).slice(0, 3),
          quality: document.documentElement.dataset.quality ?? '',
        };
      },
    };
  });

  const metrics = async () => {
    const { metrics: m } = await cdp.send('Performance.getMetrics');
    const get = (n) => m.find((x) => x.name === n)?.value ?? 0;
    return { task: get('TaskDuration'), script: get('ScriptDuration'), layout: get('LayoutDuration'), style: get('RecalcStyleDuration') };
  };
  const cpu = () =>
    app.evaluate(({ app }) =>
      app.getAppMetrics().map((m) => ({ type: m.type, name: m.name ?? m.serviceName ?? '', cum: m.cpu.cumulativeCPUUsage ?? null, pct: m.cpu.percentCPUUsage })),
    );

  async function measure(name, fn, frames = true) {
    await cpu(); // resets percentCPUUsage
    const c0 = await cpu();
    const m0 = await metrics();
    const t0 = Date.now();
    await page.evaluate((f) => window.__perf.start(f), frames);
    await fn();
    const f = await page.evaluate(() => window.__perf.stop());
    const secs = (Date.now() - t0) / 1000;
    const m1 = await metrics();
    const c1 = await cpu();
    const byType = {};
    for (const p of c1) {
      const before = c0.find((x) => x.type === p.type && x.name === p.name);
      const used = p.cum != null && before?.cum != null ? ((p.cum - before.cum) / secs) * 100 : p.pct;
      const key = p.type === 'Utility' ? `Utility` : p.type;
      byType[key] = (byType[key] ?? 0) + used;
    }
    const r = {
      name,
      secs: +secs.toFixed(1),
      ...f,
      mainMs: Math.round((m1.task - m0.task) * 1000),
      scriptMs: Math.round((m1.script - m0.script) * 1000),
      layoutMs: Math.round((m1.layout - m0.layout) * 1000),
      styleMs: Math.round((m1.style - m0.style) * 1000),
      cpu: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, +v.toFixed(1)])),
      cpuTotal: +Object.values(byType)
        .reduce((a, b) => a + b, 0)
        .toFixed(1),
    };
    results.push(r);
    const cpuStr = Object.entries(r.cpu)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ');
    console.log(
      `${name.padEnd(22)} ${String(r.secs).padStart(5)}s  frames ${String(r.frames).padStart(4)}  p50 ${r.p50.toFixed(1)} p95 ${r.p95.toFixed(1)} p99 ${r.p99.toFixed(1)} max ${r.max.toFixed(0)}  missed ${r.missed}  long ${r.longTasks}/${Math.round(r.longMs)}ms  slowEv ${r.slowEvents} (max ${Math.round(r.eventMax)})  main ${r.mainMs}ms (js ${r.scriptMs}, layout ${r.layoutMs}, style ${r.styleMs})  cpu ${r.cpuTotal}% [${cpuStr}] ${r.quality}`,
    );
    if (r.eventWorst.length) console.log(`   worst events: ${r.eventWorst.map((e) => `${e[0]} ${Math.round(e[1])} (proc ${Math.round(e[2])}, delay ${Math.round(e[3])})`).join('; ')}`);
    return r;
  }

  const box = async (sel) => (await page.locator(sel).first().boundingBox()) ?? { x: 0, y: 0, width: W, height: H };
  async function sweep(sel, passes = 3) {
    const b = await box(sel);
    for (let p = 0; p < passes; p++) {
      for (let i = 0; i <= 40; i++) {
        const t = i / 40;
        await page.mouse.move(b.x + 10 + (b.width - 20) * (p % 2 ? 1 - t : t), b.y + 10 + (b.height - 20) * ((i * 7) % 40) / 40);
        await sleep(16);
      }
    }
  }

  if (argv.includes('--trace')) {
    // --trace [session]: record a devtools timeline trace over a sidebar and a composer sweep and
    // print what was painted (paint rects by size and by layer) and the GPU raster time.
    if (argv.includes('session')) {
      await page.evaluate(() => window.sable.demo('refactor the session module', { mode: 'bypassPermissions' }));
      await page.waitForFunction(() => {
        const s = window.sable.store.getState();
        return s.sessions[s.ui.activeSessionId]?.status === 'idle';
      }, null, { timeout: 90_000 });
      await sleep(1000);
    }
    const events = [];
    cdp.on('Tracing.dataCollected', (e) => events.push(...e.value));
    const done = new Promise((r) => cdp.once('Tracing.tracingComplete', r));
    await cdp.send('Tracing.start', { transferMode: 'ReportEvents', traceConfig: { includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'cc', 'gpu', 'viz'] } });
    await sweep('.app-side', 2);
    await sweep('.cmp-card', 2);
    await cdp.send('Tracing.end');
    await done;
    const paints = new Map();
    const durs = new Map();
    for (const e of events) {
      if (e.ph === 'X' && e.dur) durs.set(e.name, (durs.get(e.name) ?? 0) + e.dur / 1000);
      if (e.name === 'Paint' && e.args?.data?.clip) {
        const c = e.args.data.clip;
        const w = Math.round(Math.abs(c[2] - c[0]));
        const h = Math.round(Math.abs(c[5] - c[1]));
        const key = `${w}x${h} node ${e.args.data.nodeId ?? '?'} layer ${e.args.data.layerId ?? '?'}`;
        const v = paints.get(key) ?? { n: 0, ms: 0 };
        v.n++;
        v.ms += (e.dur ?? 0) / 1000;
        paints.set(key, v);
      }
    }
    console.log('top durations (ms):');
    [...durs.entries()].sort((x, y) => y[1] - x[1]).slice(0, 25).forEach(([k, v]) => console.log(`  ${k.padEnd(40)} ${v.toFixed(0)}`));
    console.log('paints by rect:');
    [...paints.entries()].sort((x, y) => y[1].n - x[1].n).slice(0, 20).forEach(([k, v]) => console.log(`  ${k.padEnd(50)} n=${v.n} ms=${v.ms.toFixed(1)}`));
    const nodeIds = [...new Set([...paints.keys()].map((k) => Number(k.split(' node ')[1].split(' ')[0])).filter((n) => n > 0))].slice(0, 20);
    if (nodeIds.length) {
      await cdp.send('DOM.getDocument', { depth: -1 });
      const { nodeIds: ids } = await cdp.send('DOM.pushNodesByBackendIdsToFrontend', { backendNodeIds: nodeIds }).catch(() => ({ nodeIds: [] }));
      for (let i = 0; i < ids.length; i++) {
        if (!ids[i]) continue;
        const { node } = await cdp.send('DOM.describeNode', { nodeId: ids[i] }).catch(() => ({ node: null }));
        if (node) console.log(`  node ${nodeIds[i]} = <${node.localName} class="${(node.attributes ?? []).join(' ').slice(0, 90)}">`);
      }
    }
    throw new Error('trace done');
  }
  if (ablate) {
    // --ablate session: measure in a finished Demo session (with the sidebar listing it) instead of home.
    if (argv.includes('session')) {
      await page.evaluate(() => window.sable.demo('refactor the session module', { mode: 'bypassPermissions' }));
      await page.waitForFunction(() => {
        const s = window.sable.store.getState();
        return s.sessions[s.ui.activeSessionId]?.status === 'idle';
      }, null, { timeout: 90_000 });
      await sleep(1000);
    }
    // --ablate sidebar: only the sidebar sweep, with the candidates for what makes it slow.
    // Hover fades on opacity run on the compositor (a layer per fading element for 100 ms); colour
    // and background-color fades repaint on the main thread.
    const FADING = '.srow::before,.srow-time,.srow-more,.sgroup-count,.sgroup-tools,.side-action-kbd';
    const SIDEBAR_FADES = FADING.split(',').map((x) => `.app-side ${x}`).join(',') + '{transition:none!important}';
    const sidebarOnly = argv.includes('sidebar');
    const variants = sidebarOnly
      ? {
          base: '',
          'no transitions': '*,*::before,*::after{transition:none!important}',
          'no sidebar transitions': '.app-side *,.app-side *::before,.app-side *::after{transition:none!important}',
          'no opacity fades': SIDEBAR_FADES,
          'no spot ring': '.spot-ring{display:none!important}',
          'no dither': '.dither{display:none!important}',
          // Twice, far apart: when the two disagree, the machine was busy and the run says nothing.
          'base again': '',
        }
      : {
      base: '',
      'no spot ring': '.spot-ring{display:none!important}',
      'no transitions': '*,*::before,*::after{transition:none!important}',
      'no animations': '*,*::before,*::after{animation:none!important}',
      'no dither': '.dither{display:none!important}',
      'no dither grid': '.dither-grid::after{display:none!important}',
      'no backdrop-filter': '*{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}',
      'no shadows': '*{box-shadow:none!important}',
      'all off': '.spot-ring,.dither{display:none!important}*{backdrop-filter:none!important;box-shadow:none!important}',
        };
    for (const [name, css] of Object.entries(variants)) {
      await page.evaluate((css) => {
        let el = document.getElementById('perf-ablate');
        if (!el) {
          el = document.createElement('style');
          el.id = 'perf-ablate';
          document.head.append(el);
        }
        el.textContent = css;
      }, css);
      await sleep(600);
      if (sidebarOnly) {
        await measure(`${name}`, () => sweep('.app-side', 3));
        continue;
      }
      await measure(`${name}: idle`, () => sleep(4000), false);
      await measure(`${name}: sidebar`, () => sweep('.app-side', 2));
      await measure(`${name}: composer`, () => sweep('.cmp-card', 2));
    }
    throw new Error('ablation done');
  }
  await measure('idle home (cpu)', () => sleep(8000), false);
  await measure('idle home (frames)', () => sleep(3000));
  await measure('pointer: sidebar', () => sweep('.app-side', 3));
  await measure('pointer: composer', () => sweep('.cmp-card', 3));
  await measure('menus open/close', async () => {
    const triggers = page.locator('.cmp-card [aria-haspopup="menu"]');
    const n = Math.min(3, await triggers.count());
    for (let r = 0; r < 2; r++)
      for (let i = 0; i < n; i++) {
        await triggers.nth(i).click();
        await sleep(350);
        await page.keyboard.press('Escape');
        await sleep(250);
      }
  });
  await measure('typing (home)', async () => {
    await page.locator('.cmp-card textarea').first().click();
    await page.keyboard.type('refactor the session module so the queue drains in order and nothing re-renders ', { delay: 35 });
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Delete');
  });

  // A streaming answer in a Demo session.
  await page.evaluate(() => window.sable.demo('markdown: explain the session module in detail', { mode: 'bypassPermissions' }));
  await page.waitForSelector('.session', { timeout: 20_000 });
  await measure('streaming answer', async () => {
    await sleep(500);
    await sweep('.cmp-card', 1);
    await page.waitForFunction(() => {
      const s = window.sable.store.getState();
      return s.sessions[s.ui.activeSessionId]?.status !== 'running';
    }, null, { timeout: 30_000 }).catch(() => {});
  });
  await measure('typing (session)', async () => {
    await page.locator('.cmp-card textarea').first().click();
    await page.keyboard.type('now add tests for the queue and the steering path ', { delay: 35 });
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Delete');
  });

  // A long transcript: measure while it streams, then stop it and scroll.
  await page.evaluate(() => window.sable.demo('long', { mode: 'bypassPermissions' }));
  await sleep(1500);
  if (traceRun) {
    const events = [];
    cdp.on('Tracing.dataCollected', (e) => events.push(...e.value));
    const done = new Promise((r) => cdp.once('Tracing.tracingComplete', r));
    await cdp.send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.stack,blink,cc', transferMode: 'ReportEvents' });
    await sleep(5000);
    await cdp.send('Tracing.end');
    await done;
    const names = new Map();
    for (const e of events) if (e.ph === 'M' && e.name === 'thread_name') names.set(`${e.pid}:${e.tid}`, e.args.name);
    const by = new Map();
    for (const e of events) {
      if (e.ph !== 'X' || !e.dur) continue;
      const t = names.get(`${e.pid}:${e.tid}`) ?? '?';
      if (!/CrRendererMain|Compositor|DedicatedWorker/.test(t)) continue;
      const k = `${t.replace(/\d+/g, '')} | ${e.name}`;
      const v = by.get(k) ?? [0, 0];
      v[0] += e.dur / 1000;
      v[1]++;
      by.set(k, v);
    }
    // Style and layout forced from script, by caller (url:line:col of the built bundle).
    const forced = new Map();
    for (const e of events) {
      if (e.name !== 'Layout' && e.name !== 'UpdateLayoutTree') continue;
      const st = e.args?.beginData?.stackTrace;
      if (!st?.length) continue;
      const k = `${e.name} <- ${st.slice(0, 3).map((f) => `${f.functionName || '?'} ${f.url.replace(/.*\//, '')}:${f.lineNumber + 1}:${f.columnNumber + 1}`).join(' < ')}`;
      const v = forced.get(k) ?? [0, 0];
      v[0] += (e.dur ?? 0) / 1000;
      v[1]++;
      forced.set(k, v);
    }
    console.log('forced style/layout by caller:');
    for (const [k, v] of [...forced].sort((a, b) => b[1][1] - a[1][1]).slice(0, 14)) console.log(`  ${String(v[1]).padStart(5)}x ${v[0].toFixed(0).padStart(5)} ms  ${k}`);
    console.log('trace, 5 s, total ms by thread | event:');
    for (const [k, v] of [...by].sort((a, b) => b[1][0] - a[1][0]).slice(0, 28)) console.log(`  ${v[0].toFixed(0).padStart(6)} ms  ${String(v[1]).padStart(5)}x  ${k}`);
  }
  await measure('streaming (long)', () => sleep(10_000));
  await page.evaluate(async () => {
    const s = window.sable.store.getState();
    if (s.sessions[s.ui.activeSessionId]?.status === 'running') await window.sable.actions.interrupt(s.ui.activeSessionId);
  });
  await sleep(1500);
  await measure('scroll transcript', async () => {
    const b = await box('.tl-scroll');
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    for (let i = 0; i < 30; i++) {
      await page.mouse.wheel(0, -240);
      await sleep(40);
    }
    for (let i = 0; i < 30; i++) {
      await page.mouse.wheel(0, 240);
      await sleep(40);
    }
  });
  await measure('idle session (cpu)', () => sleep(8000), false);
  await measure('pointer: sidebar (s)', () => sweep('.app-side', 2));
} catch (err) {
  console.error('perf run failed:', err?.message ?? err);
  process.exitCode = 1;
} finally {
  await app.close().catch(() => {});
  try {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {
    /* a locked file stays in temp */
  }
}

if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ label, size: [W, H], results }, null, 2));
