'use strict';

// Shared post-processing: turn a raw RGBA render buffer into the final icon PNG.
// Used by both the headless batch worker and the interactive preview so their
// output is byte-identical. Steps: correct GL vertical flip, optional PZ
// horizontal mirror, tight alpha-trim (edge-to-edge), scale-to-fill, center.

const sharp = require('sharp');

// Tight bounding box of pixels with alpha above threshold. Returns null if none.
function alphaBBox(px, w, h, threshold) {
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (px[(y * w + x) * 4 + 3] > threshold) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/**
 * @param {Buffer} rawRGBA  bottom-up RGBA from readRenderTargetPixels
 * @param {number} width
 * @param {number} height
 * @param {{outSize?:number, downscale?:string, mirror?:boolean, padding?:number}} opts
 * @returns {Promise<Buffer>} PNG buffer
 */
async function renderIconPng(rawRGBA, width, height, opts = {}) {
  const outSize = opts.outSize || 32;
  const downscale = opts.downscale || 'nearest';
  const mirror = opts.mirror !== false;
  const margin = typeof opts.padding === 'number' ? opts.padding : 0.03;
  const kernel = downscale === 'nearest' ? sharp.kernel.nearest : sharp.kernel.lanczos3;

  let base = sharp(rawRGBA, { raw: { width, height, channels: 4 } }).flip();
  if (mirror) base = base.flop();
  const { data: px, info } = await base.raw().toBuffer({ resolveWithObject: true });

  const bb = alphaBBox(px, info.width, info.height, 8);
  const blank = () => sharp({ create: { width: outSize, height: outSize, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } });
  if (!bb) return blank().png().toBuffer();

  const inner = Math.max(1, Math.round(outSize * (1 - 2 * margin)));
  const cropped = await sharp(px, { raw: { width: info.width, height: info.height, channels: 4 } })
    .extract({ left: bb.x, top: bb.y, width: bb.w, height: bb.h })
    .resize(inner, inner, { fit: 'inside', kernel })
    .png().toBuffer();
  const cm = await sharp(cropped).metadata();
  return blank()
    .composite([{ input: cropped, left: Math.floor((outSize - cm.width) / 2), top: Math.floor((outSize - cm.height) / 2) }])
    .png().toBuffer();
}

module.exports = { renderIconPng, alphaBBox };
