// Reads a Project Zomboid player-save blob (localPlayers.data from players.db) enough to
// reconstruct the character's LOOK: gender + skin/hair/beard + worn clothing (with tints).
//
// The blob is the serialized IsoPlayer (big-endian). We don't parse the whole thing — the
// fragile bits (the Lua mod-data table, the inventory) sit before/after what we need. Instead
// we ANCHOR on the character's forename+surname strings (known from the DB `name` column),
// which sit at the top of SurvivorDesc, then walk forward through SurvivorDesc -> HumanVisual.
// Everything we want (types, colours) is stored as strings/bytes there, so no item registry is
// needed. Parsing is best-effort: on any mismatch we return what we have plus a warning.
//
// Field layout reverse-engineered from the decompiled SurvivorDesc.load / HumanVisual.load /
// ItemVisual.load / GameWindow.StringUTF (int16 length + bytes). worldVersion 247 = B42.

class Reader {
  constructor(bytes) { this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); this.u8 = bytes; this.p = 0; this.len = bytes.length; }
  u8b() { return this.u8[this.p++]; }
  i8() { const v = this.dv.getInt8(this.p); this.p += 1; return v; }
  i16() { const v = this.dv.getInt16(this.p, false); this.p += 2; return v; }
  i32() { const v = this.dv.getInt32(this.p, false); this.p += 4; return v; }
  f32() { const v = this.dv.getFloat32(this.p, false); this.p += 4; return v; }
  rgb() { return [this.u8b(), this.u8b(), this.u8b()]; }
  str() {
    const n = this.i16();
    if (n <= 0) return '';
    const s = utf8(this.u8, this.p, this.p + n); this.p += n; return s;
  }
  bytes(n) { this.p += n; }
}
function utf8(u8, a, b) { let s = ''; for (let i = a; i < b; i++) { s += String.fromCharCode(u8[i]); } try { return decodeURIComponent(escape(s)); } catch { return s; } }

// PZ string on the wire: int16 big-endian length + that many UTF-8 bytes.
function strBytes(s) {
  const enc = new TextEncoder().encode(s);
  const out = new Uint8Array(2 + enc.length);
  out[0] = (enc.length >> 8) & 0xff; out[1] = enc.length & 0xff;
  out.set(enc, 2);
  return out;
}
function indexOfBytes(hay, needle, from = 0) {
  outer: for (let i = from; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

// Find where SurvivorDesc's forename+surname pair sits, trying each split of `name` on spaces.
// Returns the byte offset just AFTER the surname string (where `torso` begins), or -1.
function anchorAfterName(u8, name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  for (let i = 1; i < words.length; i++) {
    const fore = words.slice(0, i).join(' '), sur = words.slice(i).join(' ');
    const pat = new Uint8Array([...strBytes(fore), ...strBytes(sur)]);
    const at = indexOfBytes(u8, pat);
    if (at >= 0) return at + pat.length;
  }
  // fallback: just the surname (last word), unique enough in practice
  if (words.length) {
    const at = indexOfBytes(u8, strBytes(words[words.length - 1]));
    if (at >= 0) return at + strBytes(words[words.length - 1]).length;
  }
  return -1;
}

/**
 * @param {Uint8Array} bytes  the localPlayers.data blob
 * @param {{ name: string, worldVersion?: number }} opts
 * @returns {{ ok: boolean, gender?: 'male'|'female', skinTexture?: number, skinTextureName?: string,
 *   bodyHair?: number, hair?: {model:string,color:number[]|null}, beard?: {model:string,color:number[]|null},
 *   clothing?: Array<{fullType:string, clothingItemName:string, tint:number[]|null, textureChoice:number|null, hue:number|null}>,
 *   warnings: string[] }}
 */
export function parsePlayerSave(bytes, opts = {}) {
  const warnings = [];
  const out = { ok: false, warnings };
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const wv = opts.worldVersion || 247;

  const start = anchorAfterName(u8, opts.name);
  if (start < 0) { warnings.push('could not locate the character in the save (name anchor not found)'); return out; }

  const r = new Reader(u8);
  r.p = start;
  try {
    // ---- rest of SurvivorDesc (we're positioned just after surname) ----
    r.str();                              // torso
    out.gender = r.i32() === 1 ? 'female' : 'male';
    r.str();                              // profession
    if (r.i32() === 1) { const n = r.i32(); for (let i = 0; i < n; i++) r.str(); } // extra
    const perkCount = r.i32();
    for (let i = 0; i < perkCount; i++) { r.str(); r.i32(); } // perk name + level
    if (wv >= 208) { r.str(); r.f32(); r.i32(); }             // voice prefix/pitch/type
  } catch (e) {
    warnings.push('descriptor parse failed: ' + (e instanceof Error ? e.message : String(e)));
    return out;
  }

  // ---- HumanVisual ----
  try {
    const f1 = r.u8b();
    const hairColor = (f1 & 4) ? r.rgb() : null;
    const beardColor = (f1 & 2) ? r.rgb() : null;
    const skinColor = (f1 & 8) ? r.rgb() : null;
    out.bodyHair = r.u8b();
    out.skinTexture = r.u8b();
    r.u8b();                                    // zombieRotStage
    if (f1 & 64) out.skinTextureName = r.str();
    const beardModel = (f1 & 16) ? r.str() : '';
    const hairModel = (f1 & 32) ? r.str() : '';
    out.hair = { model: hairModel, color: hairColor };
    out.beard = { model: beardModel, color: beardColor };
    void skinColor;
    for (const _ of [0, 1, 2]) { const n = r.u8b(); r.bytes(n); void _; } // blood, dirt, holes
    const nVis = r.u8b();
    const clothing = [];
    for (let i = 0; i < nVis; i++) { const v = tryItemVisual(r); if (v) clothing.push(v); } // HumanVisual.bodyVisuals (often 0)
    out.ok = true;
    // Worn clothing is usually stored as the ItemVisual embedded in each clothing InventoryItem
    // (after HumanVisual), not in bodyVisuals. Scan the rest of the blob for valid ItemVisuals.
    scanItemVisuals(u8, r.p, clothing);
    out.clothing = dedupeClothing(clothing);
  } catch (e) {
    warnings.push('appearance parse failed: ' + (e instanceof Error ? e.message : String(e)));
    out.ok = !!(out.gender || out.hair);
    // still try to salvage clothing by scanning the whole blob
    try { const c = []; scanItemVisuals(u8, start, c); out.clothing = dedupeClothing(c); } catch { /* ignore */ }
  }
  return out;
}

// Parse an ItemVisual at the reader's position; return it (advancing r) or null (restoring r).
function tryItemVisual(r) {
  const save = r.p;
  try {
    const f = r.u8b();
    const fullType = r.str();
    r.str();                                       // alternateModelName
    const clothingItemName = r.str();
    if (!/^[A-Za-z0-9_]+\.[A-Za-z0-9_ ]{2,}$/.test(fullType) || !/^[A-Za-z0-9_]{2,}$/.test(clothingItemName)) { r.p = save; return null; }
    const tint = (f & 1) ? r.rgb() : null;
    if (f & 2) r.i8();                             // baseTexture
    const textureChoice = (f & 4) ? r.i8() : null;
    const hue = (f & 8) ? r.f32() : null;
    if (f & 16) r.str();                           // decal
    for (let k = 0; k < 6; k++) { const n = r.u8b(); if (n < 0 || r.p + n > r.len) { r.p = save; return null; } r.bytes(n); }
    return { fullType, clothingItemName, tint, textureChoice, hue };
  } catch { r.p = save; return null; }
}

// Sweep [from, end) for ItemVisual structures (flags + Module.Type fullType + name), collecting
// clothing worn/carried. String-anchored, so robust to the surrounding item serialization.
function scanItemVisuals(u8, from, out) {
  const r = new Reader(u8);
  for (let i = from; i < u8.length - 4; i++) {
    // a fullType string ("Module.Type") starts 1 byte after the ItemVisual flags
    if (u8[i] !== 0) continue;                     // int16 len high byte (types are < 256 bytes)
    const n = u8[i + 1];
    if (n < 5 || n > 48 || i + 2 + n > u8.length) continue;
    let dot = false, ok = true;
    for (let j = 0; j < n; j++) { const c = u8[i + 2 + j]; if (c === 46) dot = true; else if (!((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95)) { ok = false; break; } }
    if (!ok || !dot) continue;
    r.p = i - 1;                                    // back up to the flags byte
    if (r.p < 0) continue;
    const v = tryItemVisual(r);
    if (v) { out.push(v); i = r.p - 1; }
  }
}

function dedupeClothing(list) {
  const seen = new Set(); const out = [];
  for (const c of list) { if (c && c.fullType && !seen.has(c.fullType)) { seen.add(c.fullType); out.push(c); } }
  return out;
}
