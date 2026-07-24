// Generate the desktop app icon (build/studio-icon.ico) from the web app's icon, so the desktop build
// wears the same artwork as the website. The web favicon.ico only ships 16/32/48 px, but Windows exe
// icons need a 256x256 entry, so we resize the full-resolution PWA icon (icon-512.png) into a proper
// multi-size .ico. Run: `node scripts/gen-app-icon.mjs` (uses sharp from the root node_modules).
import sharp from 'sharp';
import { mkdirSync, writeFileSync } from 'node:fs';

const SRC = 'web/public/icon-512.png';
const OUT = 'build/studio-icon.ico';
const SIZES = [16, 24, 32, 48, 64, 128, 256];

const imgs = [];
for (const size of SIZES) {
  const png = await sharp(SRC).resize(size, size, { fit: 'cover' }).png().toBuffer();
  imgs.push({ size, png });
}

// ICO container: 6-byte header, one 16-byte directory entry per image, then the PNG blobs. Windows
// (Vista+) reads PNG-compressed entries directly, so every size is stored as PNG.
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);            // reserved
header.writeUInt16LE(1, 2);            // type: icon
header.writeUInt16LE(imgs.length, 4); // image count
const dir = Buffer.alloc(16 * imgs.length);
let offset = header.length + dir.length;
imgs.forEach((im, i) => {
  const o = i * 16;
  dir[o] = im.size >= 256 ? 0 : im.size;     // width  (0 means 256)
  dir[o + 1] = im.size >= 256 ? 0 : im.size; // height (0 means 256)
  dir[o + 2] = 0;                            // palette colours
  dir[o + 3] = 0;                            // reserved
  dir.writeUInt16LE(1, o + 4);               // colour planes
  dir.writeUInt16LE(32, o + 6);              // bits per pixel
  dir.writeUInt32LE(im.png.length, o + 8);   // image byte size
  dir.writeUInt32LE(offset, o + 12);         // image offset
  offset += im.png.length;
});

mkdirSync('build', { recursive: true });
writeFileSync(OUT, Buffer.concat([header, dir, ...imgs.map((im) => im.png)]));
console.log(`wrote ${OUT} with sizes ${SIZES.join(', ')}`);
