/**
 * Idle CPU of the real desktop build, invisibly: starts `electron .` with --screenshot (the window
 * lives off-screen and is out of the taskbar) on a throwaway profile, lets it settle, then reads the
 * CPU time of every process of that run over a fixed window. Reports cores used per process type.
 *
 *   node scripts/perf-electron-idle.mjs [--eval "js run once the app rendered"] [--settle 8000] [--window 10000]
 *
 * Needs dist/ and dist-electron/ (pnpm desktop:build). Only processes started by this run are read
 * (and the run quits by itself after the capture).
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : d;
};
const settle = Number(opt('settle', '8000'));
const windowMs = Number(opt('window', '10000'));
const evalJs = opt('eval', '');

const home = path.join(os.tmpdir(), `sable-perf-electron-${process.pid}`);
rmSync(home, { recursive: true, force: true });
mkdirSync(path.join(home, 'sessions'), { recursive: true });
writeFileSync(path.join(home, 'state.json'), JSON.stringify({ projects: [], settings: { onboarded: true, prewarm: false, defaultProvider: 'demo' }, sessions: [], accounts: [] }));

const exe = path.resolve('node_modules/electron/dist/electron.exe');
const shot = path.resolve('scratch/speed/electron-idle.png');
const child = spawn(exe, ['.', `--screenshot=${shot}`, '--wait=180000', ...(evalJs ? [`--eval=${evalJs}`] : [])], {
  env: { ...process.env, SABLE_HOME: home, SABLE_USER_DATA: path.join(home, 'ud'), SABLE_DEMO: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
child.stdout.on('data', (d) => (log += d));
child.stderr.on('data', (d) => (log += d));

/** CPU seconds per process of this run (the spawned electron and all its descendants). */
function sample() {
  const out = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Select-Object ProcessId,ParentProcessId,KernelModeTime,UserModeTime,CommandLine | ConvertTo-Json -Compress`],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const all = JSON.parse(out);
  const kids = new Map();
  for (const p of all) {
    if (!kids.has(p.ParentProcessId)) kids.set(p.ParentProcessId, []);
    kids.get(p.ParentProcessId).push(p);
  }
  const mine = [];
  const walk = (pid) => {
    for (const k of kids.get(pid) ?? []) {
      mine.push(k);
      walk(k.ProcessId);
    }
  };
  const root = all.find((p) => p.ProcessId === child.pid);
  if (root) mine.push(root);
  walk(child.pid);
  const res = {};
  for (const p of mine) {
    const cl = p.CommandLine ?? '';
    const type = /--type=gpu-process/.test(cl) ? 'gpu' : /--type=renderer/.test(cl) ? 'renderer' : /--type=utility/.test(cl) ? 'utility' : /--type=/.test(cl) ? 'other' : p.ProcessId === child.pid ? 'main' : 'child';
    res[`${type}:${p.ProcessId}`] = (Number(p.KernelModeTime) + Number(p.UserModeTime)) / 1e7;
  }
  return res;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Wait for the window's renderer to exist, then let the page render and settle.
const t0 = Date.now();
while (!Object.keys(sample()).some((k) => k.startsWith('renderer:')) && Date.now() - t0 < 30_000) await sleep(500);
await sleep(settle);
const a = sample();
if (process.env.PERF_DEBUG) console.log('pids', child.pid, Object.keys(a).join(' '));
const ta = Date.now();
await sleep(windowMs);
const b = sample();
const dt = (Date.now() - ta) / 1000;
const byType = {};
for (const [k, v] of Object.entries(b)) {
  const d = v - (a[k] ?? v);
  const type = k.split(':')[0];
  byType[type] = (byType[type] ?? 0) + d;
}
const total = Object.values(byType).reduce((s, v) => s + v, 0);
console.log(
  `electron idle over ${dt.toFixed(1)}s: total ${((total / dt) * 100).toFixed(1)}% of a core | ` +
    Object.entries(byType)
      .map(([k, v]) => `${k} ${((v / dt) * 100).toFixed(1)}%`)
      .join(' | '),
);
// The capture would wait out --wait; this run is done measuring, so end it (only its own process tree).
try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ }
await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
const eval_ = log.match(/\[eval\][^\n]*/)?.[0];
if (eval_) console.log(eval_);
if (/failed|error/i.test(log)) console.log(log.split('\n').filter((l) => /failed|error/i.test(l)).slice(0, 5).join('\n'));
rmSync(home, { recursive: true, force: true });
