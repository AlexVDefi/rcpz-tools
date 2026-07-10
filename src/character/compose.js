'use strict';

// Body-texture compositor (main process, sharp). Builds the character's body
// diffuse the way the engine does: start from the skin, bake model-less clothing
// base textures on top, then erase the regions hidden by equipped masks.
//
//   base textures : composited 'over' the skin (opaque garment pixels replace skin)
//   masks         : composited 'dest-out' (dest.a *= 1 - mask.a), which erases skin
//                   under a garment exactly like bodyMask.frag's col.a * (1 - maskUnion)
//
// The icon shader already discards alpha < 0.01, so erased regions vanish.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { dataDir } = require('../runtime');

let sharp = null;
function getSharp() { return sharp || (sharp = require('sharp')); }

const OUT_DIR = path.join(dataDir(), 'work', 'body');

/** Stable signature of an outfit so identical composites hit the cache. */
function signature(skinPath, layers, maskFiles) {
  const h = crypto.createHash('md5');
  h.update(skinPath);
  for (const l of layers) h.update('|b:' + l.path + (l.tint ? ':' + l.tint.join(',') : ''));
  for (const m of maskFiles) h.update('|m:' + m);
  return h.digest('hex').slice(0, 16);
}

/** RGB-multiply a texture by a [0-1,0-1,0-1] tint (the engine's TintColour). */
async function tinted(s, texPath, tint) {
  const meta = await s(texPath).metadata();
  const bg = { r: Math.round(tint[0] * 255), g: Math.round(tint[1] * 255), b: Math.round(tint[2] * 255), alpha: 1 };
  return s(texPath).composite([{
    input: { create: { width: meta.width, height: meta.height, channels: 4, background: bg } },
    blend: 'multiply',
  }]).png().toBuffer();
}

/**
 * Compose the body diffuse and return a PNG file path (cached by signature).
 * @param {string} skinPath
 * @param {Array<{path:string, tint?:number[]}>} layers  model-less garment textures, layer order
 * @param {string[]} maskFiles  mask PNGs to erase (union), from every equipped item
 */
async function composeBody(skinPath, layers = [], maskFiles = []) {
  const s = getSharp();
  const dst = path.join(OUT_DIR, `body_${signature(skinPath, layers, maskFiles)}.png`);
  if (fs.existsSync(dst)) return dst;

  const composites = [];
  for (const l of layers) composites.push({ input: l.tint ? await tinted(s, l.path, l.tint) : l.path, blend: 'over' });
  for (const mk of maskFiles) composites.push({ input: mk, blend: 'dest-out' });

  const out = await s(skinPath).ensureAlpha().composite(composites).png().toBuffer();
  await fs.promises.mkdir(OUT_DIR, { recursive: true });
  await fs.promises.writeFile(dst, out);
  return dst;
}

module.exports = { composeBody };
