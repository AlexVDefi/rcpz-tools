// Parser for Project Zomboid .pack texture archives (tile/floor/tree sprites). Two on-disk variants,
// both real (see zombie/fileSystem/TexturePackDevice.initMetaData):
//   v1: magic "PZPK" (50 5A 50 4B), then int32 version(=1), int32 numPages. Each page's atlas PNG is
//       length-prefixed (int32 pngSize, then pngSize bytes).
//   v0 (legacy, e.g. JumboTrees2x.pack): NO magic - numPages is the very first int32. Each page's PNG
//       has NO length prefix and is terminated by scanning for the marker 0xDEADBEEF (EF BE AD DE LE).
// Per page (both): string pageName; int32 numEntries; int32 mask(=hasAlpha, no separate block); then
// numEntries x { string name; int32 x,y,w,h, ox,oy, fx,fy }. Strings are int32-len + latin-1.
// x,y,w,h = source rect in the page atlas; ox,oy = trim offset within the full sprite canvas;
// fx,fy = full untrimmed sprite size. Page images are standard RGBA PNGs.

const DEADBEEF = 0xdeadbeef | 0;

/** Parse a WHOLE pack (all pages + their PNG bytes in memory). Fine for small packs
 *  (floor pack ~42MB, JumboTrees ~9MB); do NOT use for the 1.4GB Tiles2x.pack - use indexPack.
 *  @param {Uint8Array} bytes @returns {{ version:number, pages: Array<{name:string, entries:Array, png:Uint8Array}> }} */
export function parsePack(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let o = 0;
  const i32 = () => { const v = dv.getInt32(o, true); o += 4; return v; };
  const str = () => { const n = i32(); const s = latin1(u8, o, o + n); o += n; return s; };

  let version = 0;
  if (latin1(u8, 0, 4) === 'PZPK') { o = 4; /* version */ i32(); version = 1; } else { o = 0; version = 0; }
  const numPages = i32();
  const pages = [];
  for (let p = 0; p < numPages; p++) {
    if (o + 8 > u8.length) break;
    const name = str();
    const numEntries = i32();
    /* mask (hasAlpha flag; no data block follows) */ i32();
    const entries = readEntries(i32, str, numEntries);
    let png;
    if (version === 1) {
      const pngSize = i32();
      png = u8.subarray(o, o + pngSize); o += pngSize;
    } else {
      // v0: PNG runs until the 0xDEADBEEF marker (or EOF). Scan for it.
      const end = findDeadbeef(u8, o);
      png = u8.subarray(o, end);
      o = end + 4; // skip the marker
    }
    pages.push({ name, entries, png });
  }
  return { version, pages };
}

/** Build a lightweight INDEX of a pack without loading any atlas PNG into memory - the key to using
 *  the 1.4GB Tiles2x.pack in a browser. Reads only page metadata via a byte-range reader, recording
 *  where each page's PNG lives so it can be fetched lazily later. v1 only (its PNGs are length-
 *  prefixed so they can be skipped); v0 packs are small, so callers load those whole via parsePack.
 *  @param {(offset:number,length:number)=>Promise<Uint8Array>} readRange
 *  @param {number} fileSize
 *  @returns {Promise<{ version:number, pages: Array<{name:string, entries:Array, pngOffset:number, pngSize:number }> }>} */
export async function indexPack(readRange, fileSize) {
  // A forward-only streaming reader over readRange. ensure(n) guarantees n bytes at the cursor;
  // skip(n) advances the cursor past bytes we never fetch (the atlas PNGs).
  let buf = new Uint8Array(0), bufStart = 0, pos = 0;
  const CHUNK = 1 << 16; // 64KB: covers a page's metadata in ~one read; ensure() extends if a page needs more
  const ensure = async (n) => {
    if (pos < bufStart || pos > bufStart + buf.length) { buf = new Uint8Array(0); bufStart = pos; } // cursor jumped (skip)
    else if (pos > bufStart) { buf = buf.subarray(pos - bufStart); bufStart = pos; }               // drop consumed prefix
    while (buf.length < n) {
      const start = bufStart + buf.length;
      const len = Math.min(Math.max(CHUNK, n - buf.length), fileSize - start);
      if (len <= 0) throw new Error('unexpected EOF while indexing pack');
      const chunk = await readRange(start, len);
      const merged = new Uint8Array(buf.length + chunk.length);
      merged.set(buf); merged.set(chunk, buf.length); buf = merged;
    }
  };
  const dv = () => new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const i32 = async () => { await ensure(4); const v = dv().getInt32(pos - bufStart, true); pos += 4; return v; };
  const str = async () => { const n = await i32(); await ensure(n); const off = pos - bufStart; let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(buf[off + i]); pos += n; return s; };

  await ensure(4);
  const magic = String.fromCharCode(buf[0], buf[1], buf[2], buf[3]);
  let version;
  if (magic === 'PZPK') { pos = 4; await i32(); version = 1; } else { pos = 0; version = 0; }
  if (version === 0) throw new Error('indexPack supports v1 (PZPK) only; load v0 packs whole via parsePack');
  const numPages = await i32();
  const pages = [];
  for (let p = 0; p < numPages; p++) {
    const name = await str();
    const numEntries = await i32();
    /* mask */ await i32();
    const entries = [];
    for (let e = 0; e < numEntries; e++) {
      const nm = await str();
      const x = await i32(), y = await i32(), w = await i32(), h = await i32(), ox = await i32(), oy = await i32(), fx = await i32(), fy = await i32();
      entries.push({ name: nm, x, y, w, h, ox, oy, fx, fy });
    }
    const pngSize = await i32();
    const pngOffset = pos;
    pos += pngSize; // SKIP the atlas PNG entirely (never fetched here)
    pages.push({ name, entries, pngOffset, pngSize });
  }
  return { version, pages };
}

function readEntries(i32, str, numEntries) {
  const entries = [];
  for (let e = 0; e < numEntries; e++) {
    const name = str();
    const x = i32(), y = i32(), w = i32(), h = i32(), ox = i32(), oy = i32(), fx = i32(), fy = i32();
    entries.push({ name, x, y, w, h, ox, oy, fx, fy });
  }
  return entries;
}

function findDeadbeef(u8, from) {
  for (let i = from; i + 4 <= u8.length; i++) {
    if (u8[i] === 0xef && u8[i + 1] === 0xbe && u8[i + 2] === 0xad && u8[i + 3] === 0xde) return i;
  }
  return u8.length; // no marker -> PNG runs to EOF
}
void DEADBEEF;

function latin1(u8, a, b) { let s = ''; for (let i = a; i < b; i++) s += String.fromCharCode(u8[i]); return s; }
