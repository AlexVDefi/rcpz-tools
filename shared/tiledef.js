// Parser for Project Zomboid Build 42 ".tiles" tiledefinition files (binary), which hold the per-tile
// PROPERTIES we use to classify a tile (floor / wall / rug-overlay / furniture / tree). Ported from
// zombie/iso/IsoWorld.LoadTileDefinitions. Format (verified against media/newtiledefinitions.tiles):
//   "tdef"                       4 bytes magic
//   int32  version               (=1)
//   int32  numTilesheets
//   per sheet:
//     string name                NEWLINE-terminated (read until \n) - NOT length-prefixed
//     string imageName           newline-terminated (e.g. "floors_overlay_street_01.png")
//     int32  wTiles, hTiles, tilesetNumber, nTiles
//     per tile (m = 0..nTiles-1):
//       int32 nProps
//       nProps x { string key(\n) ; string value(\n) }   // value often empty ("") for boolean flags
// Numbers are int32 little-endian; strings are \n-terminated latin-1. A tile's property KEYS include
// both flags (solidfloor, FloorOverlay, IsMoveAble...) and type names (wall, tree, doorW...) which PZ
// resolves through IsoObjectType.

/** @param {Uint8Array} bytes @returns {Map<string, { imageName:string, wTiles:number, hTiles:number, tiles: Array<{ props: Record<string,string> }> }>} keyed by sheet name */
export function parseTileDefs(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let o = 0;
  const i32 = () => { const v = dv.getInt32(o, true); o += 4; return v; };
  const strNL = () => { let s = ''; while (o < u8.length) { const c = u8[o++]; if (c === 10) break; s += String.fromCharCode(c); } return s; };
  if (String.fromCharCode(u8[0], u8[1], u8[2], u8[3]) !== 'tdef') throw new Error('not a .tiles (tdef) file');
  o = 4;
  /* version */ i32();
  const numSheets = i32();
  const sheets = new Map();
  for (let s = 0; s < numSheets; s++) {
    const name = strNL();
    const imageName = strNL();
    const wTiles = i32(), hTiles = i32(); /* tilesetNumber */ i32(); const nTiles = i32();
    const tiles = new Array(nTiles);
    for (let m = 0; m < nTiles; m++) {
      const nProps = i32();
      const props = {};
      for (let p = 0; p < nProps; p++) { const k = strNL(); const v = strNL(); props[k] = v; }
      tiles[m] = { props };
    }
    sheets.set(name, { imageName, wTiles, hTiles, tiles });
  }
  return sheets;
}

/** Merge several parsed tiledef maps (later files override earlier for the same sheet name), matching
 *  PZ's load order where patch files layer over the base. Returns one combined Map. */
export function mergeTileDefs(maps) {
  const out = new Map();
  for (const m of maps) for (const [k, v] of m) out.set(k, v);
  return out;
}
