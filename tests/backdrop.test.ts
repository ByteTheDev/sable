import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { BACKDROP_PRESETS, DEFAULT_BACKDROP, backdropCell, migrateBackdrop, migrateQuietDefault, normalizeBackdrop, sameBackdrop } from '@shared/backdrop';
import { DEFAULT_SETTINGS } from '@shared/protocol';
import { App } from '../server/app';
import { Store } from '../server/core/store';
import { registerServices } from '../server/services';
import { sniffImage } from '../server/services/backdrop';

const base = mkdtempSync(path.join(tmpdir(), 'sable-backdrop-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));

// A 1x1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

describe('module order', () => {
  // protocol.ts imports nothing at run time, so either module can load first (bundled CJS included).
  it('loads protocol first', async () => {
    vi.resetModules();
    const p = await import('../shared/protocol');
    const b = await import('../shared/backdrop');
    expect(p.DEFAULT_SETTINGS.backdropConfig).toEqual(b.DEFAULT_BACKDROP);
  });
  it('loads backdrop first', async () => {
    vi.resetModules();
    const b = await import('../shared/backdrop');
    const p = await import('../shared/protocol');
    expect(b.normalizeBackdrop(p.DEFAULT_SETTINGS.backdropConfig)).toEqual(b.DEFAULT_BACKDROP);
  });
});

describe('normalizeBackdrop', () => {
  it('fills every field from the default for empty or junk input', () => {
    expect(normalizeBackdrop(undefined)).toEqual(DEFAULT_BACKDROP);
    expect(normalizeBackdrop(null)).toEqual(DEFAULT_BACKDROP);
    expect(normalizeBackdrop('loud')).toEqual(DEFAULT_BACKDROP);
    expect(normalizeBackdrop({})).toEqual(DEFAULT_BACKDROP);
  });

  it('clamps and rounds numbers', () => {
    const c = normalizeBackdrop({ amount: 140, sessionAmount: -3, reach: 33.6, detail: '50', speed: NaN, angle: 400, hue: -1, saturation: 101, focus: { x: 1.4, y: -0.2 } });
    expect(c.amount).toBe(100);
    expect(c.sessionAmount).toBe(0);
    expect(c.reach).toBe(34);
    expect(c.detail).toBe(50);
    expect(c.speed).toBe(DEFAULT_BACKDROP.speed);
    expect(c.angle).toBe(180);
    expect(c.hue).toBe(0);
    expect(c.saturation).toBe(100);
    expect(c.focus).toEqual({ x: 1, y: 0 });
  });

  it('drops unknown values and keys', () => {
    const c = normalizeBackdrop({ source: 'video', pattern: 'bloom', style: 'blur', colour: 'red', react: 'yes', extra: 1 }) as unknown as Record<string, unknown>;
    expect(c.source).toBe(DEFAULT_BACKDROP.source);
    expect(c.pattern).toBe(DEFAULT_BACKDROP.pattern);
    expect(c.style).toBe(DEFAULT_BACKDROP.style);
    expect(c.colour).toBe(DEFAULT_BACKDROP.colour);
    expect(c.react).toBe(DEFAULT_BACKDROP.react);
    expect('extra' in c).toBe(false);
  });

  it('keeps image ids that are hex and still exist, and nothing that could name a path', () => {
    expect(normalizeBackdrop({ image: 'abc123def456' }).image).toBe('abc123def456');
    expect(normalizeBackdrop({ image: '../state.json' }).image).toBeNull();
    expect(normalizeBackdrop({ image: 'abc123def456' }, ['ffffffffffff']).image).toBeNull();
    expect(normalizeBackdrop({ image: 'abc123def456' }, ['abc123def456']).image).toBe('abc123def456');
  });

  it("allows the image's own colours only for an image source", () => {
    expect(normalizeBackdrop({ source: 'pattern', colour: 'image' }).colour).toBe('agent');
    expect(normalizeBackdrop({ source: 'image', colour: 'image' }).colour).toBe('image');
  });

  it('leaves valid configs and every preset as they are', () => {
    for (const p of BACKDROP_PRESETS) expect(sameBackdrop(normalizeBackdrop(p.config), p.config)).toBe(true);
    const names = BACKDROP_PRESETS.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('defaults calmer than the old full look, which stays reachable as a preset', () => {
    const vivid = BACKDROP_PRESETS.find((p) => p.id === 'vivid')!.config;
    expect(DEFAULT_BACKDROP.amount).toBeLessThan(vivid.amount);
    expect(backdropCell(DEFAULT_BACKDROP.detail)).toBeLessThan(5);
    expect(backdropCell(vivid.detail)).toBe(5);
    expect(backdropCell(100)).toBe(3);
    expect(backdropCell(0)).toBe(14);
  });
});

describe('migrateBackdrop', () => {
  it('maps the old switches once', () => {
    expect(migrateBackdrop({ ambience: 'off', backdrop: 'tiles', texture: 'ascii' })).toMatchObject({ source: 'off', pattern: 'tiles', style: 'ascii' });
    const calm = migrateBackdrop({ ambience: 'calm', backdrop: 'tubes', texture: 'dither' });
    expect(calm).toMatchObject({ source: 'pattern', pattern: 'tubes', speed: 0 });
    expect(calm.amount).toBeLessThan(DEFAULT_BACKDROP.amount);
    expect(migrateBackdrop({ ambience: 'full', backdrop: 'bloom' })).toEqual(DEFAULT_BACKDROP);
  });

  it('runs in the store for profiles before rev 3 only', () => {
    const dir = path.join(base, 'old');
    const settings = { ...DEFAULT_SETTINGS, ambience: 'calm', backdrop: 'aurora', rev: 2 } as Record<string, unknown>;
    delete settings.backdropConfig;
    delete settings.backdropImages;
    new Store(dir); // creates the folder
    writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ projects: [], sessions: [], accounts: [], settings }));
    const s = new Store(dir).state.settings as typeof DEFAULT_SETTINGS & { rev: number };
    expect(s.rev).toBe(4);
    expect(s.backdropConfig).toMatchObject({ pattern: 'aurora', speed: 0 });
    expect(s.backdropImages).toEqual([]);

    // A rev 3 profile keeps its config (normalized).
    writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ projects: [], sessions: [], accounts: [], settings: { ...s, ambience: 'off', backdropConfig: { ...s.backdropConfig, amount: 300 } } }));
    const again = new Store(dir).state.settings;
    expect(again.backdropConfig.source).toBe('pattern');
    expect(again.backdropConfig.amount).toBe(100);
  });
});

describe('migrateQuietDefault (rev 4)', () => {
  const OLD = { ...DEFAULT_BACKDROP, amount: 14, sessionAmount: 30, focus: { x: 0.72, y: 0.78 }, reach: 100, detail: 90 };
  const load = (name: string, config: unknown, rev = 3) => {
    const dir = path.join(base, name);
    new Store(dir);
    writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ projects: [], sessions: [], accounts: [], settings: { ...DEFAULT_SETTINGS, rev, backdropConfig: config } }));
    return new Store(dir).state.settings as typeof DEFAULT_SETTINGS & { rev: number };
  };

  it('moves an untouched old default to the new default', () => {
    const s = load('untouched', OLD);
    expect(s.rev).toBe(4);
    expect(s.backdropConfig).toEqual(DEFAULT_BACKDROP);
  });

  it('keeps tubes and takes the new amount (the owner profile)', () => {
    const s = load('tubes', { ...OLD, pattern: 'tubes' });
    expect(s.backdropConfig.pattern).toBe('tubes');
    expect(s.backdropConfig.amount).toBe(DEFAULT_BACKDROP.amount);
    expect(s.backdropConfig.sessionAmount).toBe(DEFAULT_BACKDROP.sessionAmount);
  });

  it('leaves every field the user changed alone', () => {
    const custom = { ...OLD, source: 'image', image: 'abcdef123456', pattern: 'aurora', style: 'ascii', amount: 40, sessionAmount: 22, focus: { x: 0.1, y: 0.2 }, reach: 50, detail: 60, speed: 70, angle: 90, colour: 'custom', hue: 200, saturation: 30, react: false };
    const s = load('custom', custom);
    expect(s.backdropConfig).toEqual({ ...custom, image: null, effect: 'none', effectAmount: DEFAULT_BACKDROP.effectAmount });
    // Only the fields at the old value move; the rest of a partly changed config stays.
    expect(migrateQuietDefault({ ...OLD, amount: 30 })).toMatchObject({ amount: 30, sessionAmount: DEFAULT_BACKDROP.sessionAmount, reach: DEFAULT_BACKDROP.reach });
  });

  it('runs once: a rev 4 profile keeps the old values if it holds them', () => {
    expect(load('rev4', OLD, 4).backdropConfig.amount).toBe(14);
  });

  it('keeps the presets apart and Vivid as the old full look', () => {
    const amounts = BACKDROP_PRESETS.map((p) => p.config.amount);
    expect(Math.min(...amounts)).toBeLessThan(DEFAULT_BACKDROP.amount);
    const vivid = BACKDROP_PRESETS.find((p) => p.id === 'vivid')!.config;
    expect(vivid).toMatchObject({ reach: 100, amount: 60 });
    expect(DEFAULT_BACKDROP.sessionAmount).toBeLessThan(30);
  });
});

describe('backdrop images', () => {
  it('recognises images by their bytes', () => {
    expect(sniffImage(PNG)).toBe('image/png');
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe('image/jpeg');
    expect(sniffImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniffImage(Buffer.from('GIF89a\0\0\0\0\0\0'))).toBe('image/gif');
    expect(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffImage(Buffer.from('short'))).toBeNull();
  });

  it('adds, reads and removes through the bridge, with ids it makes itself', async () => {
    const home = path.join(base, 'app');
    const app = new App({ home, providers: [], quiet: true });
    registerServices(app, { userHome: base });
    const events: string[] = [];
    app.subscribe((e) => events.push(e.type));

    await expect(app.call('backdrop.add', { data: Buffer.from('not an image at all').toString('base64'), width: 1, height: 1 })).rejects.toThrow(/PNG/);
    await expect(app.call('backdrop.add', { data: 'A'.repeat(12 * 1024 * 1024), width: 1, height: 1 })).rejects.toThrow(/8 MB/);

    const img = await app.call('backdrop.add', { data: PNG.toString('base64'), width: 1, height: 1 });
    expect(img.id).toMatch(/^[a-f0-9]{24}$/);
    expect(img.type).toBe('image/png');
    expect(app.store.state.settings.backdropImages.map((i) => i.id)).toEqual([img.id]);
    expect(readdirSync(path.join(home, 'backdrops'))).toEqual([`${img.id}.png`]);
    expect(events).toContain('settings.updated');

    const got = await app.call('backdrop.get', { id: img.id });
    expect(Buffer.from(got.data, 'base64').equals(PNG)).toBe(true);
    await expect(app.call('backdrop.get', { id: '../state' })).rejects.toThrow(/Unknown/);
    await expect(app.call('backdrop.get', { id: 'ffffffffffffffffffffffff' })).rejects.toThrow(/Unknown/);

    // The list is not writable through setSettings, and a config naming an unknown image is cleared.
    await app.call('app.setSettings', { patch: { backdropImages: [], backdropConfig: { ...DEFAULT_BACKDROP, source: 'image', image: 'abcdefabcdef' } } });
    expect(app.store.state.settings.backdropImages).toHaveLength(1);
    expect(app.store.state.settings.backdropConfig.image).toBeNull();

    await app.call('app.setSettings', { patch: { backdropConfig: { ...DEFAULT_BACKDROP, source: 'image', image: img.id, colour: 'image' } } });
    expect(app.store.state.settings.backdropConfig.image).toBe(img.id);

    await app.call('backdrop.remove', { id: img.id });
    expect(existsSync(path.join(home, 'backdrops', `${img.id}.png`))).toBe(false);
    expect(app.store.state.settings.backdropImages).toEqual([]);
    // The last image gone: back to the pattern, with colours that exist for it.
    expect(app.store.state.settings.backdropConfig).toMatchObject({ source: 'pattern', image: null, colour: 'agent' });
    await app.dispose?.();
  });
});
