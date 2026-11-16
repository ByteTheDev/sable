/**
 * Work per interaction, measured headless (no window): fixed scenarios against the running dev
 * server, each read through the DevTools protocol and a trace.
 *
 *   node scripts/perf-headless.mjs [--label before] [--only idle-home,sweep-side] [--repeat 1]
 *
 * Per scenario: main-thread script, style, layout and task time and counts (Performance.getMetrics
 * deltas), and from a trace the busy time of every thread that draws (renderer main, compositor,
 * raster workers, the backdrop's worker, GPU), paint count and painted area, rAF and timer counts,
 * long tasks, and the layer count afterwards. Results go to scratch/speed/<label>.json and a table
 * is printed. Uses the installed Edge (or Chrome) through playwright-core, like shot.mjs.
 */
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : d;
};
const label = opt('label', 'run');
const only = opt('only', '')
  .split(',')
  .filter(Boolean);
const repeat = Number(opt('repeat', '1'));
const size = opt('size', '1440x900').split('x').map(Number);

async function findServer() {
  if (process.env.SABLE_URL) return process.env.SABLE_URL;
  for (const port of [5173, 5174]) {
    try {
      const res = await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(1500) });
      if (res.ok && (await res.text()).includes('<title>Sable</title>')) return `http://localhost:${port}/`;
    } catch {
      /* not this one */
    }
  }
  throw new Error('No Sable dev server on 5173/5174.');
}

const CATEGORIES = [
  'toplevel',
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.frame',
  'gpu',
  'viz',
  ...(process.env.PERF_DETAIL ? ['disabled-by-default-devtools.timeline.stack'] : []),
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── trace analysis ──

function analyse(events) {
  const procName = new Map();
  const threadName = new Map();
  for (const e of events) {
    if (e.ph !== 'M') continue;
    if (e.name === 'process_name') procName.set(e.pid, e.args.name);
    if (e.name === 'thread_name') threadName.set(`${e.pid}:${e.tid}`, e.args.name);
  }
  // The page's renderer: the process whose main thread ran FireAnimationFrame / Layout / our scripts.
  const kind = (pid, tid) => {
    const t = threadName.get(`${pid}:${tid}`) ?? '';
    const p = procName.get(pid) ?? '';
    if (p === 'Renderer') {
      if (t === 'CrRendererMain') return 'main';
      if (t === 'Compositor') return 'compositor';
      if (t.startsWith('CompositorTileWorker')) return 'raster';
      if (t.startsWith('DedicatedWorker')) return 'worker';
      return 'renderer-other';
    }
    if (p === 'GPU Process') {
      if (t === 'CrGpuMain') return 'gpu';
      if (t === 'VizCompositorThread') return 'viz';
      return 'gpu-other';
    }
    if (p === 'Browser') return 'browser';
    return 'other';
  };

  // Busy time per thread kind: the union of top-level task intervals.
  const intervals = new Map();
  const out = {
    styleN: 0,
    styleMs: 0,
    layoutN: 0,
    layoutMs: 0,
    paintN: 0,
    paintMs: 0,
    paintArea: 0,
    prePaintMs: 0,
    layerizeMs: 0,
    commitN: 0,
    rafReq: 0,
    rafFire: 0,
    timerInstall: 0,
    timerFire: 0,
    rasterN: 0,
    rasterMs: 0,
    gpuTaskMs: 0,
    longTasks: 0,
    eventN: 0,
    frames: 0,
  };
  for (const e of events) {
    if (e.ph === 'M') continue;
    const k = kind(e.pid, e.tid);
    const dur = (e.dur ?? 0) / 1000;
    if (e.ph === 'X' && (e.name === 'ThreadControllerImpl::RunTask' || e.name === 'RunTask' || e.name === 'ThreadPool_RunTask')) {
      if (!intervals.has(k)) intervals.set(k, []);
      intervals.get(k).push([e.ts, e.ts + e.dur]);
      if (k === 'main' && dur > 50) out.longTasks++;
    }
    if (k === 'main' && process.env.PERF_DETAIL && e.ph === 'X') {
      const key =
        e.name === 'FunctionCall'
          ? `fn ${e.args?.data?.functionName || '?'} ${String(e.args?.data?.url ?? '').split('/').pop()}:${e.args?.data?.lineNumber ?? ''}`
          : e.name === 'TimeStamp'
            ? `ts ${e.args?.data?.message ?? e.args?.data?.name ?? '?'}`
            : e.name === 'EventDispatch'
            ? `event ${e.args?.data?.type}`
            : e.name === 'TimerFire'
              ? `timer ${e.args?.data?.timerId}`
              : e.name;
      const d0 = (out.detail ??= {});
      const slot = (d0[key] ??= [0, 0]);
      slot[0]++;
      slot[1] += dur;
      // Forced (synchronous) style and layout: who asked.
      const st = e.args?.beginData?.stackTrace ?? e.args?.data?.stackTrace;
      if ((e.name === 'Layout' || e.name === 'UpdateLayoutTree') && st?.length) {
        const f = st[0];
        const k2 = `forced ${e.name === 'Layout' ? 'layout' : 'style'} ${f.functionName || '?'} ${String(f.url).split('/').pop().split('?')[0]}:${f.lineNumber}`;
        const s2 = (d0[k2] ??= [0, 0]);
        s2[0]++;
        s2[1] += dur;
      }
    }
    if (k === 'main') {
      switch (e.name) {
        case 'UpdateLayoutTree':
          if (e.ph === 'X') {
            out.styleN++;
            out.styleMs += dur;
            const n = e.args?.elementCount ?? 0;
            out.styleEls = (out.styleEls ?? 0) + n;
            out.styleMax = Math.max(out.styleMax ?? 0, n);
          }
          break;
        case 'Layout':
          if (e.ph === 'X') (out.layoutN++, (out.layoutMs += dur));
          break;
        case 'Paint': {
          if (e.ph !== 'X') break;
          out.paintN++;
          out.paintMs += dur;
          const q = e.args?.data?.clip;
          if (q && q.length >= 8) {
            // Clip to the viewport: a layer's paint can report an unbounded clip.
            const xs = [q[0], q[2], q[4], q[6]].map((v) => Math.max(0, Math.min(size[0], v)));
            const ys = [q[1], q[3], q[5], q[7]].map((v) => Math.max(0, Math.min(size[1], v)));
            const area = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
            out.paintArea += area;
            if (process.env.PERF_DETAIL) {
              const pn = (out.paintNodes ??= {});
              const id = e.args.data.nodeId ?? 0;
              const s = (pn[id] ??= [0, 0, 0, `${Math.round(Math.max(...xs) - Math.min(...xs))}x${Math.round(Math.max(...ys) - Math.min(...ys))}`]);
              s[0]++;
              s[1] += area;
              s[2] += dur;
            }
          }
          break;
        }
        case 'PrePaint':
          if (e.ph === 'X') out.prePaintMs += dur;
          break;
        case 'Layerize':
          if (e.ph === 'X') out.layerizeMs += dur;
          break;
        case 'Commit':
          if (e.ph === 'X') out.commitN++;
          break;
        case 'RequestAnimationFrame':
          out.rafReq++;
          break;
        case 'FireAnimationFrame':
          if (e.ph === 'X') out.rafFire++;
          break;
        case 'TimerInstall':
          out.timerInstall++;
          break;
        case 'TimerFire':
          if (e.ph === 'X') out.timerFire++;
          break;
        case 'EventDispatch':
          if (e.ph === 'X') out.eventN++;
          break;
        case 'BeginMainThreadFrame':
          out.frames++;
          break;
      }
    }
    if (e.name === 'RasterTask' && e.ph === 'X') (out.rasterN++, (out.rasterMs += dur));
    if (e.name === 'GPUTask' && e.ph === 'X') out.gpuTaskMs += dur;
  }
  const busy = {};
  for (const [k, list] of intervals) {
    list.sort((a, b) => a[0] - b[0]);
    let total = 0;
    let s = -1;
    let end = -1;
    for (const [a, b] of list) {
      if (a > end) {
        if (end > s) total += end - s;
        s = a;
        end = b;
      } else if (b > end) end = b;
    }
    if (end > s) total += end - s;
    busy[k] = total / 1000;
  }
  out.busy = busy;
  return out;
}

// ── harness ──

const url = await findServer();
const candidates = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
];
const exe = candidates.find((p) => existsSync(p));
const browser = await chromium.launch({ headless: true, ...(exe ? { executablePath: exe } : { channel: 'chrome' }) });
const context = await browser.newContext({ viewport: { width: size[0], height: size[1] }, colorScheme: 'dark' });
// A production build exposes the `sable` helpers only to a debug desktop shell: stand one in
// (with page-drawn window controls, as on Windows). Its home agent is Demo, so nothing prewarms.
await context.addInitScript(() => {
  try {
    const ui = JSON.parse(localStorage.getItem('sable.ui.v1') ?? '{}');
    localStorage.setItem('sable.ui.v1', JSON.stringify({ ...ui, homeProvider: 'demo' }));
  } catch {
    /* ignore */
  }
  if (location.port === '5173' || location.port === '5174') return;
  window.sableDesktop = {
    platform: 'win32',
    version: '0.1.0',
    debug: true,
    window: { minimize() {}, toggleMaximize() {}, close() {}, getState: async () => ({ maximized: false, focused: true, fullScreen: false }), onState: () => () => {} },
  };
});
// PERF_RENDERS=1: count React component renders per commit through the devtools hook
// (a fiber with the PerformedWork flag ran its component this commit). Dev server for names.
if (process.env.PERF_RENDERS)
  await context.addInitScript(() => {
    window.__renders = {};
    const nameOf = (f) => {
      const t = f.type;
      if (!t || typeof t === 'string') return null;
      return t.displayName || t.name || t.render?.displayName || t.render?.name || t.type?.displayName || t.type?.name || null;
    };
    // Skipped subtrees keep stale flags from their last render, so a fiber counts only when it also
    // started work after the previous commit (dev builds time every unit of work).
    let since = 0;
    const walk = (f) => {
      while (f) {
        if (f.flags & 1 && (f.actualStartTime ?? Infinity) > since) {
          const n = nameOf(f);
          if (n) window.__renders[n] = (window.__renders[n] ?? 0) + 1;
        }
        if (f.child) walk(f.child);
        f = f.sibling;
      }
    };
    window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true,
      renderers: new Map(),
      inject() {
        return 1;
      },
      onCommitFiberRoot(_id, root) {
        try {
          walk(root.current.child);
        } catch {
          /* ignore */
        }
        since = performance.now();
      },
      onCommitFiberUnmount() {},
      onPostCommitFiberRoot() {},
      checkDCE() {},
    };
  });
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send('Performance.enable', { timeDomain: 'threadTicks' });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text().slice(0, 200)}`));

async function metrics() {
  const { metrics } = await cdp.send('Performance.getMetrics');
  return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
}

async function layerCount() {
  const got = new Promise((resolve) => {
    const on = (e) => {
      if (!e.layers) return;
      cdp.off('LayerTree.layerTreeDidChange', on);
      resolve(e.layers);
    };
    cdp.on('LayerTree.layerTreeDidChange', on);
  });
  await cdp.send('LayerTree.enable');
  // A frame has to be produced for the tree to be reported.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const layers = await Promise.race([got, sleep(3000).then(() => null)]);
  await cdp.send('LayerTree.disable');
  if (!layers) return { layers: -1, drawn: -1, area: 0 };
  const drawn = layers.filter((l) => l.drawsContent);
  if (process.env.PERF_LAYERS) {
    await cdp.send('DOM.getDocument', { depth: 0 });
    const names = [];
    for (const l of layers) {
      let who = l.backendNodeId ? '?' : '-';
      if (l.backendNodeId)
        try {
          const { node } = await cdp.send('DOM.describeNode', { backendNodeId: l.backendNodeId });
          const cls = (node.attributes ?? []).reduce((acc, v, i, arr) => (v === 'class' ? arr[i + 1] : acc), '');
          who = `${node.localName || node.nodeName}.${cls.split(' ').slice(0, 2).join('.')}`;
        } catch {
          /* gone */
        }
      names.push(`${who}${l.drawsContent ? '' : '(empty)'} ${Math.round(l.width)}x${Math.round(l.height)}`);
    }
    console.log(`    layers: ${names.join(' | ')}`);
  }
  return { layers: layers.length, drawn: drawn.length, area: Math.round(drawn.reduce((s, l) => s + l.width * l.height, 0) / 1000) };
}

async function measure(name, run) {
  // In-page: long animation frames and running CSS / Web animations.
  await page.evaluate(() => {
    window.__loaf = [];
    window.__loafObs?.disconnect();
    try {
      window.__loafObs = new PerformanceObserver((l) =>
        window.__loaf.push(
          ...l.getEntries().map((e) => {
            const d = e.duration;
            const s = new Number(d);
            // Where the frame went: scripts (by invoker), then rendering (style/layout, paint).
            s.info = `${Math.round(d)}ms: render ${Math.round(e.startTime + d - (e.renderStart || e.startTime + d))} style+layout ${Math.round(e.startTime + d - (e.styleAndLayoutStart || e.startTime + d))} | ${(e.scripts ?? [])
              .map((x) => `${x.invoker || x.name} ${Math.round(x.duration)}ms (fsl ${Math.round(x.forcedStyleAndLayoutDuration)})`)
              .join(', ')}`;
            return s;
          }),
        ),
      );
      window.__loafObs.observe({ type: 'long-animation-frame', buffered: false });
    } catch {
      /* unsupported */
    }
  });
  await page.evaluate(() => (window.__renders = {}));
  const m0 = await metrics();
  await browser.startTracing(page, { categories: CATEGORIES });
  const t0 = Date.now();
  await run();
  const wall = Date.now() - t0;
  const buf = await browser.stopTracing();
  const m1 = await metrics();
  const trace = JSON.parse(buf.toString());
  const a = analyse(trace.traceEvents ?? trace);
  const page2 = await page.evaluate(() => {
    const anims = document.getAnimations().filter((x) => x.playState === 'running');
    const who = anims.slice(0, 6).map((x) => {
      const t = x.effect?.target;
      return t ? `${t.tagName.toLowerCase()}.${String(t.className?.baseVal ?? t.className).split(' ').slice(0, 2).join('.')}` : '?';
    });
    const field = document.querySelector('.dither');
    return {
      loaf: window.__loaf.length,
      loafMs: Math.round(window.__loaf.reduce((s, d) => s + d, 0)),
      anims: anims.length,
      who,
      focus: document.hasFocus(),
      loafInfo: window.__loaf.map((x) => x.info),
      field: field ? `${field.dataset.thread}/${field.dataset.ms ?? '-'}ms/q${document.documentElement.dataset.quality ?? 0}` : 'none',
    };
  });
  if (process.env.PERF_DETAIL) for (const l of page2.loafInfo.slice(0, 8)) console.log(`    loaf ${l}`);
  delete page2.loafInfo;
  if (process.env.PERF_RENDERS) {
    const r = await page.evaluate(() => window.__renders);
    const top = Object.entries(r ?? {})
      .sort((x, y) => y[1] - x[1])
      .slice(0, 30);
    console.log(`    renders: ${top.map(([k, v]) => `${k} ${v}`).join(', ')}`);
  }
  if (a.paintNodes) {
    await cdp.send('DOM.getDocument', { depth: 0 });
    const top = Object.entries(a.paintNodes)
      .sort((x, y) => y[1][1] - x[1][1])
      .slice(0, 10);
    for (const [id, s] of top) {
      let who = '?';
      try {
        const { node } = await cdp.send('DOM.describeNode', { backendNodeId: Number(id) });
        const cls = (node.attributes ?? []).reduce((acc, v, i, arr) => (v === 'class' ? arr[i + 1] : acc), '');
        who = `${node.localName || node.nodeName}.${cls.split(' ').slice(0, 3).join('.')}`;
      } catch {
        /* gone */
      }
      console.log(`    paint ${who.padEnd(50)} n=${s[0]} area=${(s[1] / 1e6).toFixed(1)}Mpx ${s[2].toFixed(1)}ms last ${s[3]}`);
    }
  }
  const L = await layerCount();
  const d = (k) => (m1[k] ?? 0) - (m0[k] ?? 0);
  return {
    name,
    wall,
    scriptMs: +(d('ScriptDuration') * 1000).toFixed(1),
    styleMs: +(d('RecalcStyleDuration') * 1000).toFixed(1),
    styleN: d('RecalcStyleCount'),
    layoutMs: +(d('LayoutDuration') * 1000).toFixed(1),
    layoutN: d('LayoutCount'),
    taskMs: +(d('TaskDuration') * 1000).toFixed(1),
    trace: a,
    ...page2,
    ...L,
  };
}

const ev = (js) => page.evaluate(js);

async function waitIdle(id, timeout = 60_000) {
  await page.waitForFunction((sid) => window.sable.store.getState().sessions[sid]?.status === 'idle', id, { timeout, polling: 250 });
}

async function sweep(from, to, steps = 60, gap = 16) {
  await page.mouse.move(from[0], from[1]);
  for (let i = 1; i <= steps; i++) {
    const k = i / steps;
    await page.mouse.move(from[0] + (to[0] - from[0]) * k, from[1] + (to[1] - from[1]) * k);
    await sleep(gap);
  }
}

async function box(sel) {
  const b = await page.locator(sel).first().boundingBox();
  if (!b) throw new Error(`no box for ${sel}`);
  return b;
}

let finishedId = null;
let longId = null;

async function home() {
  await ev(() => window.sable.actions.goHome());
  await page.mouse.move(size[0] - 4, size[1] - 4);
  await sleep(1500);
}

async function finishedSession() {
  if (!finishedId) {
    finishedId = await ev(() => window.sable.demo('hi', { mode: 'bypassPermissions' }));
    await waitIdle(finishedId);
  } else await ev((id) => window.sable.actions.openSession(id), finishedId);
  await ev(() => window.sable.store.getState().setUi({ railOpen: false }));
  await page.mouse.move(size[0] / 2, size[1] - 40);
  await sleep(1500);
}

const SCENARIOS = {
  'idle-home': async () => {
    await home();
    return measure('idle-home', () => sleep(10_000));
  },
  'idle-session': async () => {
    await finishedSession();
    return measure('idle-session', () => sleep(10_000));
  },
  'sweep-side': async () => {
    await home();
    const b = await box('.side-list');
    return measure('sweep-side', () => sweep([b.x + b.width / 2, b.y + 10], [b.x + b.width / 2, b.y + Math.min(b.height, 600) - 10]));
  },
  'sweep-stage': async () => {
    await finishedSession();
    await ev(() => window.sable.store.getState().setUi({ railOpen: true, railTab: 'files' }));
    await sleep(900);
    return measure('sweep-stage', () => sweep([300, size[1] * 0.45], [size[0] - 20, size[1] * 0.55], 80));
  },
  'sweep-composer': async () => {
    await finishedSession();
    const b = await box('.cmp-card');
    return measure('sweep-composer', () => sweep([b.x + 10, b.y + b.height / 2], [b.x + b.width - 10, b.y + b.height / 2], 60));
  },
  // One session's shown fields change (as a status or activity event does): what re-renders.
  'touch-session': async () => {
    await home();
    return measure('touch-session', async () => {
      for (let i = 0; i < 10; i++) {
        await ev((n) => {
          const st = window.sable.store.getState();
          const ids = Object.keys(st.sessions);
          const id = ids[ids.length - 1];
          window.sable.store.setState({ sessions: { ...st.sessions, [id]: { ...st.sessions[id], activity: `touch ${n}`, updatedAt: Date.now() } } });
        }, i);
        await sleep(100);
      }
    });
  },
  'menu-model': async () => {
    await finishedSession();
    return measure('menu-model', async () => {
      for (let i = 0; i < 2; i++) {
        await page.click('.cm-model');
        await sleep(400);
        await page.keyboard.press('Escape');
        await sleep(400);
      }
    });
  },
  'menu-effort': async () => {
    await finishedSession();
    return measure('menu-effort', async () => {
      for (let i = 0; i < 2; i++) {
        await page.click('.th-chip');
        await sleep(400);
        await page.keyboard.press('Escape');
        await sleep(400);
      }
    });
  },
  settings: async () => {
    await finishedSession();
    return measure('settings', async () => {
      for (let i = 0; i < 2; i++) {
        await ev(() => window.sable.actions.openSettings());
        await sleep(700);
        await page.keyboard.press('Escape');
        await sleep(600);
      }
    });
  },
  menus: async () => {
    await finishedSession();
    return measure('menus', async () => {
      await page.click('.cm-model');
      await sleep(400);
      await page.keyboard.press('Escape');
      await sleep(400);
      await page.click('.th-chip');
      await sleep(400);
      await page.keyboard.press('Escape');
      await sleep(400);
      await ev(() => window.sable.actions.openSettings());
      await sleep(700);
      await page.keyboard.press('Escape');
      await sleep(600);
    });
  },
  type: async () => {
    await finishedSession();
    await page.click('.composer textarea:not(.cmp-mirror)');
    await sleep(300);
    const r = await measure('type', () => page.keyboard.type('make the session expiry check run hourly', { delay: 35 }));
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
    return r;
  },
  stream: async () => {
    await home();
    return measure('stream', async () => {
      longId = await ev(() => window.sable.demo('long', { mode: 'bypassPermissions' }));
      await sleep(8000);
    });
  },
  scroll: async () => {
    if (!longId) {
      longId = await ev(() => window.sable.demo('long', { mode: 'bypassPermissions' }));
    } else await ev((id) => window.sable.actions.openSession(id), longId);
    await waitIdle(longId, 120_000);
    await ev(() => window.sable.store.getState().setUi({ railOpen: false }));
    await sleep(1200);
    const b = await box('.tl-scroll');
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    return measure('scroll', async () => {
      for (let i = 0; i < 30; i++) (await page.mouse.wheel(0, -100), await sleep(16));
      for (let i = 0; i < 30; i++) (await page.mouse.wheel(0, 100), await sleep(16));
      await sleep(300);
    });
  },
  'drag-rail': async () => {
    await finishedSession();
    await ev(() => window.sable.store.getState().setUi({ railOpen: true, railTab: 'files' }));
    await sleep(900);
    const b = await box('.rail-resize');
    const x = b.x + b.width / 2;
    const y = b.y + b.height / 2;
    const r = await measure('drag-rail', async () => {
      await page.mouse.move(x, y);
      await page.mouse.down();
      for (let i = 1; i <= 40; i++) (await page.mouse.move(x - i * 5, y), await sleep(16));
      for (let i = 39; i >= 0; i--) (await page.mouse.move(x - i * 5, y), await sleep(16));
      await page.mouse.up();
      await sleep(300);
    });
    return r;
  },
};

const results = [];
try {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.sable?.store.getState().ready, null, { timeout: 30_000 });
  // The backdrop as a new install has it (DEFAULT_BACKDROP), set locally only: backdropLive is never saved by itself.
  const bd = opt('backdrop', 'default');
  await page.evaluate((mode) => {
    const DEFAULT = { source: 'pattern', pattern: 'streaks', image: null, style: 'dither', amount: 14, sessionAmount: 30, focus: { x: 0.72, y: 0.78 }, reach: 100, detail: 90, speed: 30, angle: 35, colour: 'agent', hue: 28, saturation: 70, react: true };
    const cfg = mode === 'off' ? { ...DEFAULT, source: 'off' } : mode === 'still' ? { ...DEFAULT, speed: 0 } : DEFAULT;
    window.sable.store.setState({ backdropLive: cfg });
  }, bd);
  // Experiments: --css "rule" is added to the page before measuring.
  const css = opt('css', '');
  if (css) await page.addStyleTag({ content: css });
  await sleep(3000);
  const names = Object.keys(SCENARIOS).filter((n) => !only.length || only.includes(n));
  for (let rep = 0; rep < repeat; rep++)
    for (const n of names) {
      try {
        const r = await SCENARIOS[n]();
        results.push(r);
        const t = r.trace;
        const b = t.busy;
        console.log(
          [
            n.padEnd(13),
            `main ${(b.main ?? 0).toFixed(0)}ms`,
            `script ${r.scriptMs}`,
            `style ${r.styleN}/${r.styleMs}ms els ${t.styleEls ?? 0} max ${t.styleMax ?? 0}`,
            `layout ${r.layoutN}/${r.layoutMs}ms`,
            `paint ${t.paintN}/${t.paintMs.toFixed(1)}ms ${(t.paintArea / 1e6).toFixed(2)}Mpx`,
            `raster ${t.rasterN}/${t.rasterMs.toFixed(0)}ms`,
            `comp ${(b.compositor ?? 0).toFixed(0)}`,
            `worker ${(b.worker ?? 0).toFixed(0)}`,
            `gpu ${((b.gpu ?? 0) + (b.viz ?? 0)).toFixed(0)}`,
            `raf ${t.rafReq}/${t.rafFire}`,
            `timers ${t.timerInstall}/${t.timerFire}`,
            `frames ${t.frames}`,
            `long ${t.longTasks} loaf ${r.loaf}/${r.loafMs}ms`,
            `anims ${r.anims}${r.anims ? ` [${r.who.join(' ')}]` : ''}`,
            `layers ${r.layers}/${r.drawn} ${r.area}kpx`,
            `focus ${r.focus} field ${r.field}`,
          ].join(' | '),
        );
        if (t.detail)
          console.log(
            Object.entries(t.detail)
              .sort((a, b) => b[1][1] - a[1][1])
              .slice(0, 25)
              .map(([k, [c, ms]]) => `    ${k.padEnd(60)} ${String(c).padStart(5)} ${ms.toFixed(1)}ms`)
              .join('\n'),
          );
      } catch (err) {
        console.log(n, 'failed:', err.message.split('\n')[0]);
      }
    }
} finally {
  mkdirSync(path.resolve('scratch/speed'), { recursive: true });
  writeFileSync(path.resolve(`scratch/speed/${label}.json`), JSON.stringify(results, null, 1));
  if (errors.length) console.log([...new Set(errors)].slice(0, 8).join('\n'));
  await browser.close();
}
