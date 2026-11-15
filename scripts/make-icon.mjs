// Renders the Sable mark (src/art/Logo.tsx, public/favicon.svg) as the desktop app icon:
// build/icon.ico (16, 20, 24, 32, 40, 48, 64, 96, 128, 256 px, PNG-compressed entries) and
// build/icon.png (512 px). Each size is drawn at its own pixel size in headless Edge (or Chrome)
// through playwright-core, the same way scripts/shot.mjs launches it.
//
// The mark is a 4 x 4 field of square cells: a solid block whose last corner dissolves into
// ordered dither (two cells out, the corner cell holding on by a point). Every size is hinted by
// hand: the cell is a whole number of pixels, so no edge ever falls on half a pixel. The plate is
// flat ink (one hairline from 48 px up, so it holds its edge on a dark taskbar).
//
//   node scripts/make-icon.mjs [--previews]   (previews go to scratch/icon/)
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'build');
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];

/** The mark's outline in cell units (same as MARK_PATH in src/art/Logo.tsx). */
const MARK_PATH = 'M0 0H4V2H3V3H2V4H0Z M3 3H4V4H3Z';

/**
 * Cell size in pixels per icon size: the glyph spans about 55% of the canvas (a little less on
 * the big tiles, where a solid block reads heavier), more at the smallest sizes so the cells
 * stay readable. Every value keeps the glyph centred on whole pixels.
 */
const CELL = { 16: 3, 20: 3, 24: 4, 32: 5, 40: 6, 48: 7, 64: 9, 96: 13, 128: 17, 256: 35, 512: 69 };

const INK = '#0c0c0e';
const IVORY = '#f2f1ee';

function svg(size) {
  const cell = CELL[size];
  // Large icons sit a hair inside their canvas, as Windows icons do; small ones use every pixel.
  const inset = size >= 32 ? Math.round(size / 32) : 0;
  const side = size - inset * 2;
  const radius = size <= 16 ? 3.5 : +(side * 0.225).toFixed(2);
  // The block's weight sits up and left of its box (the missing cells are bottom right): from
  // 64 px up the glyph moves a whole pixel or two toward that corner so it looks centred.
  const nudge = size >= 64 ? Math.round(cell * 0.07) : 0;
  const at = (size - cell * 4) / 2 + nudge;
  const hair = size >= 48 ? Math.max(1, Math.round(size / 128)) : 0;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect x="${inset}" y="${inset}" width="${side}" height="${side}" rx="${radius}" fill="${INK}"/>
  ${hair ? `<rect x="${inset + hair / 2}" y="${inset + hair / 2}" width="${side - hair}" height="${side - hair}" rx="${radius - hair / 2}" fill="none" stroke="#fff" stroke-opacity="0.1" stroke-width="${hair}"/>` : ''}
  <path transform="translate(${at} ${at}) scale(${cell})" fill="${IVORY}" d="${MARK_PATH}" shape-rendering="crispEdges"/>
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
  if (process.argv.includes('--previews')) {
    const dir = path.join(root, 'scratch', 'icon');
    mkdirSync(dir, { recursive: true });
    for (const { size, png } of images) writeFileSync(path.join(dir, `app-${size}.png`), png);
  }
  console.log(`Wrote build/icon.ico (${ICO_SIZES.join(', ')} px) and build/icon.png (512 px)`);
} finally {
  await browser.close();
}
