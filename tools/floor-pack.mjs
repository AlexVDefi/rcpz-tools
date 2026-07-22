// Build a MINIMAL Tiles2x floor pack holding only the tiles the scene-view floor presets use.
// The game's Tiles2x.floor.pack is ~44MB across 11 atlas pages, but the six presets (Grass, Dry
// grass, Dirt, Sand, Asphalt, Wood) reference just 30 sprites. We crop those out and repack them
// into a single small atlas (sub-MB), keeping the same PZPK format the app already parses. The
// FloorLibrary decodes the result unchanged - its de-shear + dither-blend logic only reads each
// sprite's x/y/w/h rect, so tile blending keeps working exactly as with the full pack.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { parsePack } from '../shared/pack.js';

// Mirror FLOOR_PRESETS in web/src/CharacterViewer.tsx. blends_natural_01 groups solid tiles at
// {b, b+5, b+6, b+7} per 16-index block: 0=sand, 16&32=grass, 48=dry grass, 64=dirt.
const NB = (b) => [b, b + 5, b + 6, b + 7].map((i) => `blends_natural_01_${i}`);
const P = (base, ...idx) => idx.map((i) => `${base}_${i}`);
export const FLOOR_TILES = [
  ...NB(16), ...NB(32), ...NB(48), ...NB(64), ...NB(0),
  ...P('floors_exterior_street_01', 0, 1, 2, 3, 4, 5, 6, 7, 8),
  ...P('floors_interior_tilesandwood_01', 47),
];

// The exact (lowercased) media path the FloorLibrary asks resolveMediaPath for.
export const FLOOR_PACK_VPATH = 'media/texturepacks/tiles2x.floor.pack';

function findPack(install) {
  const dir = path.join(install, 'media', 'texturepacks');
  const hit = fs.readdirSync(dir).find((n) => /^tiles2x\.floor\.pack$/i.test(n));
  if (!hit) throw new Error(`Tiles2x.floor.pack not found in ${dir}`);
  return path.join(dir, hit);
}

/** Read the game's Tiles2x.floor.pack and return a minimal PZPK Buffer with only the preset tiles. */
export async function buildMinimalFloorPack(install) {
  const { pages } = parsePack(fs.readFileSync(findPack(install)));
  const want = new Set(FLOOR_TILES);
  const picks = []; // { e, pageIdx } - first page a needed tile appears on wins
  const seen = new Set();
  pages.forEach((pg, pi) => pg.entries.forEach((e) => {
    if (want.has(e.name) && !seen.has(e.name)) { seen.add(e.name); picks.push({ e, pageIdx: pi }); }
  }));
  const missing = FLOOR_TILES.filter((n) => !seen.has(n));
  if (missing.length) throw new Error(`floor tiles missing from pack: ${missing.join(', ')}`);

  // Shelf-pack the crops into one atlas (2px gutter guards against edge bleed when repeated).
  const GUT = 2, MAXW = 2048;
  const sorted = [...picks].sort((a, b) => b.e.h - a.e.h);
  let x = 0, y = 0, shelfH = 0, atlasW = 0;
  const placed = []; // { e, pageIdx, nx, ny }
  for (const p of sorted) {
    if (x + p.e.w + GUT > MAXW && x > 0) { y += shelfH + GUT; x = 0; shelfH = 0; }
    placed.push({ e: p.e, pageIdx: p.pageIdx, nx: x, ny: y });
    x += p.e.w + GUT; shelfH = Math.max(shelfH, p.e.h); atlasW = Math.max(atlasW, x);
  }
  const atlasH = y + shelfH;

  // Decode each source page once; extract each crop as raw RGBA and composite into the new atlas.
  const composites = [];
  for (const p of placed) {
    const raw = await sharp(Buffer.from(pages[p.pageIdx].png))
      .extract({ left: p.e.x, top: p.e.y, width: p.e.w, height: p.e.h })
      .ensureAlpha().raw().toBuffer();
    composites.push({ input: raw, raw: { width: p.e.w, height: p.e.h, channels: 4 }, left: p.nx, top: p.ny });
  }
  const png = await sharp({ create: { width: atlasW, height: atlasH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(composites).png({ compressionLevel: 9 }).toBuffer();

  return encodePack(placed, png);
}

// Emit a single-page PZPK: "PZPK" + version + numPages, then page(name, numEntries, mask, entries, png).
function encodePack(placed, png) {
  const chunks = [];
  const i32 = (v) => { const b = Buffer.alloc(4); b.writeInt32LE(v | 0, 0); chunks.push(b); };
  const str = (s) => { i32(Buffer.byteLength(s, 'latin1')); chunks.push(Buffer.from(s, 'latin1')); };
  chunks.push(Buffer.from('PZPK', 'latin1'));
  i32(1);             // version (parser ignores it)
  i32(1);             // numPages
  str('floors_min');  // page name
  i32(placed.length); // numEntries
  i32(0);             // mask flag (no mask block follows)
  for (const p of placed) {
    str(p.e.name);
    i32(p.nx); i32(p.ny); i32(p.e.w); i32(p.e.h); i32(p.e.ox); i32(p.e.oy); i32(p.e.fx); i32(p.e.fy);
  }
  i32(png.length);
  chunks.push(Buffer.from(png));
  return Buffer.concat(chunks);
}
