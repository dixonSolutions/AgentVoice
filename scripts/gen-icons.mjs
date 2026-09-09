#!/usr/bin/env node
/**
 * Rasterize the committed SVG brand sources.
 *
 * Requires: npm install --save-dev sharp
 * Run:      node scripts/gen-icons.mjs
 *
 * Sources (hand-edited, authoritative):
 *   web/public/icon.svg            — full-bleed mark, `purpose: any` + favicon
 *   web/public/icon-maskable.svg   — safe-zone mark, `purpose: maskable`
 *   docs/images/banner.svg         — README / social banner
 *
 * Outputs are committed so the PWA, the README and the VS Code extension all
 * work without running this. Re-run only when an SVG changes.
 *
 * The banner PNG is generated because GitHub's README pipeline is the one
 * consumer that cannot be relied on to rasterize SVG text identically (or at
 * all) across themes and clients — every other surface takes the SVG.
 */

import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

let sharp;
try {
  sharp = (await import('sharp')).default;
} catch {
  console.error(
    'sharp is not installed. Run: npm install --save-dev sharp\n' +
      'Then: node scripts/gen-icons.mjs',
  );
  process.exit(1);
}

/** @type {{ src: string; out: string; width: number; height?: number }[]} */
const targets = [
  { src: 'web/public/icon.svg', out: 'web/public/icon-192.png', width: 192 },
  { src: 'web/public/icon.svg', out: 'web/public/icon-512.png', width: 512 },
  { src: 'web/public/icon-maskable.svg', out: 'web/public/icon-maskable-512.png', width: 512 },
  { src: 'docs/images/banner.svg', out: 'docs/images/banner.png', width: 1200, height: 360 },
  // The Marketplace gallery icon. Same mark as the PWA — the desk client and
  // the phone client are one product, so they must not drift apart visually.
  // 128px is what both the VS Code and Open VSX galleries render at.
  { src: 'web/public/icon.svg', out: 'vscode/media/icon.png', width: 128 },
];

for (const { src, out, width, height } of targets) {
  const svg = readFileSync(resolve(root, src));
  const outPath = resolve(root, out);
  mkdirSync(dirname(outPath), { recursive: true });
  // `density` scales the SVG rasterizer's DPI so wide artwork is not resampled
  // up from a 96dpi bitmap — without it the banner text renders soft.
  await sharp(svg, { density: 384 })
    .resize(width, height ?? width, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(outPath);
  console.log(`✓ ${out}`);
}

console.log('Brand assets generated.');
