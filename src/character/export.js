'use strict';

// Character export (main process, sharp). Writes a single still PNG or tiles a
// set of animation frames into a sprite sheet. Sprite sheets are the dependency
// -free animated export: they drop straight into Photoshop / engines, and a GIF
// can be made from one there. (sharp 0.33 can't encode animated GIF from frames.)

const fs = require('fs');
const path = require('path');

let sharp = null;
function getSharp() { return sharp || (sharp = require('sharp')); }

const fromDataUrl = (d) => Buffer.from(String(d).replace(/^data:image\/png;base64,/, ''), 'base64');

async function saveStill(dataUrl, outPath) {
  await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
  await fs.promises.writeFile(outPath, fromDataUrl(dataUrl));
  return outPath;
}

/** Tile frames left-to-right, top-to-bottom into a transparent sprite sheet. */
async function saveSpriteSheet(frames, outPath, cols) {
  const s = getSharp();
  const bufs = frames.map(fromDataUrl);
  const meta = await s(bufs[0]).metadata();
  const w = meta.width, h = meta.height;
  const columns = cols || Math.ceil(Math.sqrt(bufs.length));
  const rows = Math.ceil(bufs.length / columns);
  const composites = bufs.map((input, i) => ({ input, left: (i % columns) * w, top: Math.floor(i / columns) * h }));
  const sheet = await s({ create: { width: columns * w, height: rows * h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(composites).png().toBuffer();
  await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
  await fs.promises.writeFile(outPath, sheet);
  return { outPath, columns, rows, frameWidth: w, frameHeight: h };
}

module.exports = { saveStill, saveSpriteSheet };
