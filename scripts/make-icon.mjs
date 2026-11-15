// Renders the Sable mark (src/art/Logo.tsx, public/favicon.svg) as the desktop app icon:
// build/icon.ico (16, 24, 32, 48, 64, 128, 256 px, PNG-compressed entries) and build/icon.png (512 px).
// Each size is drawn as a vector at its own pixel size in headless Edge (or Chrome) through
// playwright-core, the same way scripts/shot.mjs launches it. 16 and 24 px use a simplified,
// pixel-snapped drawing: the full mark's smallest tiles turn to mush at that size.
//
//   node scripts/make-icon.mjs
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'build');
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

/** The full mark's tiles in the favicon's 32-unit space: the big tile, then pieces breaking off it, each a step dimmer. */
const FULL = [
  { x: 6, y: 6, s: 12.6, r: 3.6, a: 1 },
  { x: 20.8, y: 6, s: 5.2, r: 1.7, a: 0.78 },
  { x: 6, y: 20.8, s: 5.2, r: 1.7, a: 0.78 },
  { x: 20.8, y: 13.4, s: 5.2, r: 1.7, a: 0.54 },
  { x: 13.4, y: 20.8, s: 5.2, r: 1.7, a: 0.54 },
  { x: 21.6, y: 21.6, s: 3.6, r: 1.2, a: 0.3 },
];

/** Small sizes: the big tile and three whole pieces on whole pixels (units are pixels of that size). */
const SMALL = {
  16: { r: 3.5, tiles: [{ x: 3, y: 3, s: 6, r: 1.3, a: 1 }, { x: 10, y: 3, s: 3, r: 0.5, a: 0.8 }, { x: 3, y: 10, s: 3, r: 0.5, a: 0.8 }, { x: 10, y: 10, s: 3, r: 0.5, a: 0.5 }] },
  24: { r: 5.5, tiles: [{ x: 4, y: 4, s: 9, r: 2.4, a: 1 }, { x: 15, y: 4, s: 5, r: 1.4, a: 0.8 }, { x: 4, y: 15, s: 5, r: 1.4, a: 0.8 }, { x: 15, y: 15, s: 5, r: 1.4, a: 0.5 }] },
};

function svg(size) {
  const small = SMALL[size];
  // Large icons sit a hair inside their canvas, as Windows icons do; small ones use every pixel.
  const inset = small ? 0 : Math.round(size / 32);
  const side = size - inset * 2;
  const k = small ? 1 : side / 32;
  const radius = small ? small.r : 8 * k;
  const tiles = (small ? small.tiles : FULL)
    .map((t) => `<rect x="${inset + t.x * k}" y="${inset + t.y * k}" width="${t.s * k}" height="${t.s * k}" rx="${t.r * k}" opacity="${t.a}"/>`)
    .join('');
  const edge = Math.max(1, size / 128);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#18181b"/><stop offset="1" stop-color="#09090a"/></linearGradient>
    <linearGradient id="lit" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0.16"/><stop offset="0.45" stop-color="#fff" stop-opacity="0.03"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
    <linearGradient id="ivory" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f7f6f3"/><stop offset="1" stop-color="#dedcd6"/></linearGradient>
  </defs>
  <rect x="${inset}" y="${inset}" width="${side}" height="${side}" rx="${radius}" fill="url(#bg)"/>
  ${small ? '' : `<rect x="${inset + edge / 2}" y="${inset + edge / 2}" width="${side - edge}" height="${side - edge}" rx="${radius - edge / 2}" fill="none" stroke="url(#lit)" stroke-width="${edge}"/>`}
  <g fill="url(#ivory)">${tiles}</g>
</svg>`;
}

/** An ICO container with PNG entries: a 6-byte header, a 16-byte directory entry per image, then the PNGs. */
function ico(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, i) => {
    const e = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, e); // 0 means 256
    header.writeUInt8(size >= 256 ? 0 : size, e + 1);
    header.writeUInt8(0, e + 2); // no palette
    header.writeUInt8(0, e + 3);
    header.writeUInt16LE(1, e + 4); // colour planes
    header.writeUInt16LE(32, e + 6); // bits per pixel
    header.writeUInt32LE(png.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map((i) => i.png)]);
}

const candidates = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
];
const found = candidates.find((p) => existsSync(p));
const browser = await chromium.launch({ headless: true, ...(found ? { executablePath: found } : { channel: 'chrome' }) });
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const render = async (size) => {
    await page.setViewportSize({ width: Math.max(size, 64), height: Math.max(size, 64) });
    await page.setContent(`<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block}</style>${svg(size)}`);
    return page.locator('svg').screenshot({ omitBackground: true, type: 'png' });
  };
  const images = [];
  for (const size of ICO_SIZES) images.push({ size, png: await render(size) });
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, 'icon.ico'), ico(images));
  writeFileSync(path.join(out, 'icon.png'), await render(512));
  for (const { size, png } of images) if (process.argv.includes('--previews')) writeFileSync(path.join(root, 'scratch', `icon-${size}.png`), png);
  console.log(`Wrote build/icon.ico (${ICO_SIZES.join(', ')} px) and build/icon.png (512 px)`);
} finally {
  await browser.close();
}
