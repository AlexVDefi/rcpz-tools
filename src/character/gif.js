'use strict';

// Animated GIF export (main process, gifenc + sharp). Encodes the character
// animation as a looping GIF and auto-optimises frame count + palette size to fit
// a byte budget at a fixed resolution -- e.g. 512x512 under 1 MB for a Steam
// Workshop preview.
//
// File size is driven mostly by frame count and colours (LZW compresses the
// static background well), so the optimiser steps both down, best-quality first,
// and returns the first plan that fits.

const fs = require('fs');
const path = require('path');
const { GIFEncoder, quantize, applyPalette } = require('gifenc');

let sharp = null;
function getSharp() { return sharp || (sharp = require('sharp')); }

const fromDataUrl = (d) => Buffer.from(String(d).replace(/^data:image\/png;base64,/, ''), 'base64');

/** Build one palette covering the WHOLE animation, sampled across every frame.
 *  Quantising from a single frame lets colours that only appear in other frames
 *  remap inconsistently frame-to-frame, which reads as flicker on the clothing;
 *  a gamut-covering shared palette removes that. Sampled (every 4th pixel) so the
 *  quantise stays fast. Built from the ORIGINAL (undithered) frames. */
function buildSharedPalette(frames, colors, format, transparent) {
  const step = 4 * 4; // stride over RGBA, every 4th pixel
  let per = 0;
  for (let i = 0; i < frames[0].length; i += step) per++;
  const sample = new Uint8Array(frames.length * per * 4);
  let o = 0;
  for (const f of frames) {
    for (let i = 0; i < f.length; i += step) {
      sample[o++] = f[i]; sample[o++] = f[i + 1]; sample[o++] = f[i + 2]; sample[o++] = f[i + 3];
    }
  }
  return quantize(sample.subarray(0, o), colors, { format, oneBitAlpha: transparent ? 128 : false });
}

// Median-cut allocates few palette entries to large low-variance dark regions
// (e.g. a black jacket), so its subtle shades band and flip frame-to-frame. An
// ordered (Bayer 4x4) dither breaks that banding by scattering pixels across the
// nearest few entries in a FIXED spatial pattern -- deterministic per position,
// so it reads as smooth shading over time rather than flicker. The flat
// background is left untouched (it has an exact palette entry).
const BAYER4 = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];
function ditherFrame(frame, width, height, amount, bg) {
  const out = new Uint8Array(frame.length);
  const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      const r = frame[p], g = frame[p + 1], b = frame[p + 2], a = frame[p + 3];
      const skip = bg ? (Math.abs(r - bg[0]) + Math.abs(g - bg[1]) + Math.abs(b - bg[2]) < 10) : a < 8;
      if (skip) { out[p] = r; out[p + 1] = g; out[p + 2] = b; out[p + 3] = a; continue; }
      const t = (BAYER4[y & 3][x & 3] / 15 - 0.5) * amount;
      out[p] = clamp(r + t); out[p + 1] = clamp(g + t); out[p + 2] = clamp(b + t); out[p + 3] = a;
    }
  }
  return out;
}

/** Encode a set of raw RGBA frames to a GIF buffer with a shared palette.
 *  `delayMs` is the per-frame delay in milliseconds (gifenc rounds to centiseconds). */
function encodeGif(frames, { width, height, colors, delayMs, transparent, bg }) {
  const format = transparent ? 'rgba4444' : 'rgb565';
  const palette = buildSharedPalette(frames, colors, format, transparent);
  // stronger dither for coarser palettes (bigger quantisation steps to hide)
  const amount = Math.min(24, Math.round(12 * Math.sqrt(256 / colors)));
  const gif = GIFEncoder();
  for (const rgba of frames) {
    const dithered = ditherFrame(rgba, width, height, amount, transparent ? null : bg);
    const index = applyPalette(dithered, palette, format);
    gif.writeFrame(index, width, height, transparent
      ? { palette, delay: delayMs, transparent: true, transparentIndex: 0, dispose: 2 }
      : { palette, delay: delayMs });
  }
  gif.finish();
  return gif.bytes();
}

/** Evenly pick `n` frames from `total`. */
function pick(frames, n) {
  const total = frames.length;
  if (n >= total) return frames.slice();
  const out = [];
  for (let i = 0; i < n; i++) out.push(frames[Math.round(i * (total - 1) / (n - 1))]);
  return out;
}

/**
 * Try progressively lower-quality plans until the GIF fits `maxBytes`.
 * @param {Buffer[]} raws  raw RGBA frame buffers
 * @returns {{buffer, frames, colors, bytes, delayCs, fit}}
 */
function encodeAuto(raws, { width, height, duration, maxBytes, transparent, bg }) {
  const total = raws.length;
  const f = (frac) => Math.max(4, Math.round(total * frac));
  const plans = [
    [total, 256], [total, 128], [total, 64],
    [f(0.75), 128], [f(0.75), 64],
    [f(0.6), 96], [f(0.6), 48],
    [f(0.5), 64], [f(0.5), 32],
    [f(0.4), 48], [f(0.4), 24],
    [Math.max(6, f(0.3)), 24], [6, 16],
  ];
  let last = null;
  for (const [fc, colors] of plans) {
    const n = Math.max(4, Math.min(total, fc));
    const frames = pick(raws, n);
    // keep the loop's total duration equal to the clip so it plays at natural speed
    const delayMs = Math.max(20, Math.round(1000 * duration / n));
    const buffer = encodeGif(frames, { width, height, colors, delayMs, transparent, bg });
    last = { buffer, frames: n, colors, bytes: buffer.length, delayMs, fit: buffer.length <= maxBytes };
    if (last.fit) return last;
  }
  return last; // smallest achievable; may still exceed budget (caller warns)
}

/** Decode PNG data URLs to raw RGBA (flattened onto a background unless transparent). */
async function decodeFrames(dataUrls, { transparent, background }) {
  const s = getSharp();
  const raws = [];
  let width = 0, height = 0;
  for (const d of dataUrls) {
    let img = s(fromDataUrl(d));
    if (!transparent && background) img = img.flatten({ background });
    const { data, info } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    raws.push(data); width = info.width; height = info.height;
  }
  return { raws, width, height };
}

/** Parse '#rrggbb' -> [r,g,b]. */
function hexToRgb(hex) {
  const n = parseInt(String(hex).replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Full pipeline: decode frames, auto-optimise, write the GIF, return a report. */
async function saveGifAuto(dataUrls, outPath, { duration, maxBytes, transparent, background }) {
  const { raws, width, height } = await decodeFrames(dataUrls, { transparent, background });
  const bg = transparent ? null : hexToRgb(background || '#000000');
  const r = encodeAuto(raws, { width, height, duration, maxBytes, transparent, bg });
  await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
  await fs.promises.writeFile(outPath, Buffer.from(r.buffer));
  return { outPath, width, height, frames: r.frames, colors: r.colors, bytes: r.bytes, fit: r.fit, maxBytes };
}

module.exports = { saveGifAuto, encodeGif, encodeAuto };
