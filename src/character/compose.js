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
 *
 * The vanilla skin is a small atlas (256px), while mod garment textures are often
 * higher-res (512/1024/2048) in the SAME UV layout. sharp refuses to composite an
 * input larger than the base ("Image to composite must have same dimensions or
 * smaller"), so a naive skin-as-base composite throws and the garment silently
 * fails to apply. Instead we pick the largest atlas size present and normalise the
 * skin plus every layer/mask to it, so they align and no detail is thrown away.
 *
 * @param {string} skinPath
 * @param {Array<{path:string, tint?:number[]}>} layers  model-less garment textures, layer order
 * @param {string[]} maskFiles  mask PNGs to erase (union), from every equipped item
 */
async function composeBody(skinPath, layers = [], maskFiles = []) {
  const s = getSharp();
  const dst = path.join(OUT_DIR, `body_${signature(skinPath, layers, maskFiles)}.png`);
  if (fs.existsSync(dst)) return dst;

  // resolve every layer to a concrete input (tinted layers become buffers)
  const layerInputs = [];
  for (const l of layers) layerInputs.push(l.tint ? await tinted(s, l.path, l.tint) : l.path);

  // target = the largest side across the skin and every garment/mask atlas
  let target = 0;
  for (const input of [skinPath, ...layerInputs, ...maskFiles]) {
    const m = await s(input).metadata();
    target = Math.max(target, m.width || 0, m.height || 0);
  }

  // normalise everything to target x target so the shared UV atlas lines up
  const fit = (input) => s(input).resize(target, target, { fit: 'fill' }).png().toBuffer();
  const composites = [];
  for (const input of layerInputs) composites.push({ input: await fit(input), blend: 'over' });
  for (const mk of maskFiles) composites.push({ input: await fit(mk), blend: 'dest-out' });

  const out = await s(skinPath).resize(target, target, { fit: 'fill' }).ensureAlpha().composite(composites).png().toBuffer();
  await fs.promises.mkdir(OUT_DIR, { recursive: true });
  await fs.promises.writeFile(dst, out);
  return dst;
}

module.exports = { composeBody };
