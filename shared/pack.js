// Parser for Project Zomboid .pack texture archives (used for tile/floor sprites).
//
// Format (little-endian int32), reverse-engineered (see ShootThroughBarricades tools):
//   "PZPK"  magic
//   int32   version
//   int32   numPages
//   per page:
//     string  pageName            (int32 len + latin-1 bytes)
//     int32   numEntries
//     int32   mask
//     numEntries x: string name; int32 x,y,w,h,ox,oy,fx,fy   (sprite rect + iso offset/full)
//     int32   pngSize ; pngSize bytes   (page atlas PNG)
//     [if mask + bytes remain] int32 maskSize ; maskSize bytes
//     [if bytes remain]        int32 0xDEADBEEF marker
// (Some packs — e.g. Tiles1x.floor.pack — end right after the atlas PNG with no mask/marker,
//  so every tail read is guarded against EOF.)

/** @param {Uint8Array} bytes @returns {{ pages: Array<{name:string, entries:Array, png:Uint8Array}> }} */
export function parsePack(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let o = 0;
  const i32 = () => { const v = dv.getInt32(o, true); o += 4; return v; };
  const str = () => { const n = i32(); const s = latin1(u8, o, o + n); o += n; return s; };

  if (latin1(u8, 0, 4) !== 'PZPK') throw new Error('not a PZPK pack');
  o = 4;
  /* version */ i32();
  const numPages = i32();
  const pages = [];
  for (let p = 0; p < numPages; p++) {
    if (o + 8 > u8.length) break;
    const name = str();
    const numEntries = i32();
    const mask = i32();
    const entries = [];
    for (let e = 0; e < numEntries; e++) {
      const nm = str();
      const x = i32(), y = i32(), w = i32(), h = i32(), ox = i32(), oy = i32(), fx = i32(), fy = i32();
      entries.push({ name: nm, x, y, w, h, ox, oy, fx, fy });
    }
    const pngSize = i32();
    const png = u8.subarray(o, o + pngSize); o += pngSize;
    pages.push({ name, entries, png });
    // tolerant tail: optional mask block, optional marker
    if (mask && o + 4 <= u8.length) { const ms = dv.getInt32(o, true); if (o + 4 + ms <= u8.length) o += 4 + ms; }
    if (o + 4 <= u8.length) i32(); // 0xDEADBEEF marker (absent on some packs)
  }
  return { pages };
}

function latin1(u8, a, b) { let s = ''; for (let i = a; i < b; i++) s += String.fromCharCode(u8[i]); return s; }
