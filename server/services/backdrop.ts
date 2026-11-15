import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isBackdropImageId, normalizeBackdrop } from '../../shared/backdrop';
import type { BackdropImage } from '../../shared/protocol';
import type { App } from '../app';

/** Largest image the bridge stores (the UI scales to 2048 px and re-encodes, so real uploads are far smaller). */
export const MAX_BACKDROP_BYTES = 8 * 1024 * 1024;

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

/** The image type from its first bytes, or null when it is not an image this accepts. */
export function sniffImage(b: Uint8Array): string | null {
  if (b.length < 12) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return 'image/gif';
  return null;
}

/**
 * Backdrop images under `<store dir>/backdrops/<id>.<ext>`. Ids are random hex made here, and a
 * file name is only ever built from a checked id and a fixed extension: nothing a caller sends
 * reaches the file system as a path.
 */
export class BackdropImages {
  readonly dir: string;

  constructor(storeDir: string) {
    this.dir = path.join(storeDir, 'backdrops');
  }

  private file(img: Pick<BackdropImage, 'id' | 'type'>) {
    if (!isBackdropImageId(img.id) || !EXT[img.type]) throw new Error('Unknown image');
    return path.join(this.dir, `${img.id}.${EXT[img.type]}`);
  }

  async add(base64: string, width: number, height: number): Promise<BackdropImage> {
    if (typeof base64 !== 'string' || !base64) throw new Error('No image data');
    // Base64 is 4/3 of the bytes: refuse oversized input before decoding it.
    if (base64.length > Math.ceil((MAX_BACKDROP_BYTES * 4) / 3) + 4) throw new Error('Image is larger than 8 MB');
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.length > MAX_BACKDROP_BYTES) throw new Error('Image is larger than 8 MB');
    const type = sniffImage(bytes);
    if (!type) throw new Error('Not a PNG, JPEG, WebP or GIF image');
    const dim = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.min(16384, Math.round(n)) : 0);
    const img: BackdropImage = { id: randomBytes(12).toString('hex'), type, width: dim(width), height: dim(height), bytes: bytes.length, addedAt: Date.now() };
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.file(img), bytes);
    return img;
  }

  async read(img: BackdropImage): Promise<string> {
    return (await readFile(this.file(img))).toString('base64');
  }

  async remove(img: BackdropImage) {
    await rm(this.file(img), { force: true });
  }
}

export function registerBackdrop(app: App) {
  const images = new BackdropImages(app.store.dir);
  const settings = () => app.store.state.settings;
  const find = (id: unknown) => {
    const img = isBackdropImageId(id) ? settings().backdropImages.find((i) => i.id === id) : undefined;
    if (!img) throw new Error('Unknown image');
    return img;
  };
  const changed = () => {
    app.store.saveState();
    app.emit({ type: 'settings.updated', settings: settings() });
  };

  app.register('backdrop.add', async ({ data, width, height }) => {
    const img = await images.add(data, width, height);
    const s = settings();
    s.backdropImages = [...s.backdropImages, img];
    changed();
    return img;
  });

  app.register('backdrop.get', async ({ id }) => {
    const img = find(id);
    return { id: img.id, type: img.type, data: await images.read(img) };
  });

  app.register('backdrop.remove', async ({ id }) => {
    const img = find(id);
    await images.remove(img);
    const s = settings();
    s.backdropImages = s.backdropImages.filter((i) => i.id !== img.id);
    if (s.backdropConfig.image === img.id) {
      // Show the most recent image left, or none (the backdrop then draws nothing until one is chosen).
      const next = s.backdropImages[s.backdropImages.length - 1]?.id ?? null;
      s.backdropConfig = normalizeBackdrop({ ...s.backdropConfig, image: next, source: next || s.backdropConfig.source !== 'image' ? s.backdropConfig.source : 'pattern' });
    }
    changed();
    return { ok: true };
  });
}
