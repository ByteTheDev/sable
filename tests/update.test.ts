/**
 * Updates of the desktop app (server/services/update.ts): which release counts as newer, which
 * asset is the installer, a download checked against GitHub's size and SHA-256, and a restart
 * that waits while agents work. No network: GitHub is a fake `fetch`.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UpdateState } from '../shared/protocol';
import { newer, pickRelease, RELEASES_URL, Updater } from '../server/services/update';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.useRealTimers();
});

const BYTES = Buffer.from('MZ fake installer '.repeat(5000));
const SHA = createHash('sha256').update(BYTES).digest('hex');

function release(version: string, over: Record<string, unknown> = {}) {
  return {
    tag_name: `v${version}`,
    draft: false,
    prerelease: false,
    assets: [
      { name: `Sable-Android-${version}.apk`, browser_download_url: `https://github.com/x/y/releases/download/v${version}/a.apk`, size: 10 },
      { name: `Sable-Setup-${version}.exe`, browser_download_url: `https://github.com/x/y/releases/download/v${version}/Sable-Setup-${version}.exe`, size: BYTES.length, digest: `sha256:${SHA}` },
    ],
    ...over,
  };
}

/** GitHub as a fake: the latest release's JSON, and the installer's bytes (in a few chunks). */
function github(json: unknown, bytes: Buffer = BYTES) {
  const calls: string[] = [];
  const fetcher = (async (url: string | URL) => {
    calls.push(String(url));
    if (String(url) === RELEASES_URL) return new Response(JSON.stringify(json), { status: 200 });
    const parts = [bytes.subarray(0, 1000), bytes.subarray(1000, 40000), bytes.subarray(40000)];
    const body = new ReadableStream({
      start(c) {
        for (const p of parts) c.enqueue(new Uint8Array(p));
        c.close();
      },
    });
    return new Response(body, { status: 200 });
  }) as typeof fetch;
  return { fetcher, calls };
}

function updater(json: unknown, opts: { busy?: () => boolean; bytes?: Buffer } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'sable-update-test-'));
  dirs.push(dir);
  const states: UpdateState[] = [];
  const ran: string[] = [];
  const quit = vi.fn();
  const gh = github(json, opts.bytes);
  const u = new Updater((s) => states.push(s), { host: { quit }, dir, version: '0.2.4', fetch: gh.fetcher, run: (f) => ran.push(f), busy: opts.busy, manual: true });
  return { u, states, ran, quit, dir, gh };
}

describe('which release is newer', () => {
  it('compares versions by number', () => {
    expect(newer('0.2.5', '0.2.4')).toBe(true);
    expect(newer('0.2.10', '0.2.9')).toBe(true);
    expect(newer('0.3.0', '0.2.99')).toBe(true);
    expect(newer('v1.0.0', '0.9.9')).toBe(true);
    expect(newer('0.2.4', '0.2.4')).toBe(false);
    expect(newer('0.2.3', '0.2.4')).toBe(false);
  });

  it('takes the Windows installer of a published release only', () => {
    const r = pickRelease(release('0.2.5'));
    expect(r).toMatchObject({ version: '0.2.5', name: 'Sable-Setup-0.2.5.exe', size: BYTES.length, sha256: SHA });
    expect(pickRelease(release('0.2.5', { draft: true }))).toBeNull();
    expect(pickRelease(release('0.2.5', { prerelease: true }))).toBeNull();
    expect(pickRelease(release('0.2.5', { assets: [] }))).toBeNull();
    expect(pickRelease({ ...release('0.2.5'), tag_name: 'nightly' })).toBeNull();
    // A download from anywhere but GitHub is never taken.
    const bad = release('0.2.5');
    bad.assets[1].browser_download_url = 'https://example.com/Sable-Setup-0.2.5.exe';
    expect(pickRelease(bad)).toBeNull();
  });
});

describe('the updater', () => {
  it('stays idle when the latest release is the running one', async () => {
    const { u, gh } = updater(release('0.2.4'));
    const s = await u.check(true);
    expect(s.status).toBe('idle');
    expect(s.latest).toBeUndefined();
    expect(gh.calls).toEqual([RELEASES_URL]);
  });

  it('downloads a newer release, checks it, and restarts into it', async () => {
    const { u, states, ran, quit, dir } = updater(release('0.2.5'));
    vi.useFakeTimers();
    const s = await u.check();
    expect(s).toMatchObject({ status: 'ready', latest: '0.2.5', progress: 1 });
    expect(states.some((x) => x.status === 'downloading')).toBe(true);
    const file = path.join(dir, 'Sable-Setup-0.2.5.exe');
    expect(readFileSync(file).equals(BYTES)).toBe(true);
    expect(existsSync(`${file}.part`)).toBe(false);

    u.install();
    expect(ran).toEqual([file]);
    vi.advanceTimersByTime(500);
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it('throws a download away that does not match the release', async () => {
    const wrong = Buffer.from(BYTES);
    wrong[100] = 0x41 === wrong[100] ? 0x42 : 0x41;
    const { u, dir } = updater(release('0.2.5'), { bytes: wrong });
    const s = await u.check(true);
    expect(s.status).toBe('error');
    expect(s.error).toMatch(/did not match/);
    expect(existsSync(path.join(dir, 'Sable-Setup-0.2.5.exe'))).toBe(false);
    expect(existsSync(path.join(dir, 'Sable-Setup-0.2.5.exe.part'))).toBe(false);
  });

  it('says nothing when a check of its own fails, and why when the person asked', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sable-update-test-'));
    dirs.push(dir);
    const down = (async () => new Response('', { status: 503 })) as typeof fetch;
    const u = new Updater(() => {}, { host: { quit: () => {} }, dir, version: '0.2.4', fetch: down, manual: true });
    expect((await u.check()).status).toBe('idle');
    const s = await u.check(true);
    expect(s.status).toBe('error');
    expect(s.error).toContain('503');
  });

  it('waits for the agents to finish before it restarts, and can be called off', async () => {
    let busy = true;
    const { u, ran } = updater(release('0.2.5'), { busy: () => busy });
    await u.check();
    expect(u.install().pending).toBe(true);
    expect(ran).toHaveLength(0);
    u.workChanged();
    expect(ran).toHaveLength(0);
    busy = false;
    u.workChanged();
    expect(ran).toHaveLength(1);

    // Called off: work ending later restarts nothing.
    busy = true;
    const second = updater(release('0.2.5'), { busy: () => busy });
    await second.u.check();
    second.u.install();
    expect(second.u.install(true).pending).toBeUndefined();
    busy = false;
    second.u.workChanged();
    expect(second.ran).toHaveLength(0);
  });

  it('does nothing where Sable cannot update itself', async () => {
    const u = new Updater(() => {}, { version: '0.2.4', manual: true });
    expect((await u.check(true)).status).toBe('unsupported');
    expect(() => u.install()).toThrow();
  });
});
