// Item display-name translations, read from PZ translation files through the AssetSource seam.
//
// PZ stores item names per language under `media/lua/shared/Translate/<LANG>/`:
//   - Build 42: `ItemName.json` - a JSON object of BARE fullType -> display name, e.g.
//       { "Base.Axe": "Axe", "Bicycle.Bicycle": "Bicycle (Beige)" }
//   - Build 41: `ItemName_<LANG>.txt` - a Kahlua table with `ItemName_<module>.<item> = "Name"`
//       (some languages quote the key: `"ItemName_..." : "Name"`).
// Either way the useful part is the ITEM name (the segment after the first dot); the app keys its
// clothing/held items by that name, so we index by it (lowercased).
//
// Loading is per-source so each mod resolves in its own translations first, with a per-mod English
// fallback, matching the game. A source with no ItemName file at all contributes nothing, so those
// items keep showing their raw name.

import { parseScriptText, walkBlocks, prop } from './script-parser.js';

const LANG_SEGS = ['media', 'lua', 'shared', 'translate'];

// Friendly names for the language codes PZ ships (fallback: the code itself).
export const LANGUAGE_NAMES = {
  EN: 'English', AR: 'Arabic', CA: 'Catalan', CH: 'Chinese (Traditional)', CN: 'Chinese (Simplified)',
  CS: 'Czech', DA: 'Danish', DE: 'German', ES: 'Spanish', FI: 'Finnish', FR: 'French', HU: 'Hungarian',
  ID: 'Indonesian', IT: 'Italian', JP: 'Japanese', KO: 'Korean', NL: 'Dutch', NO: 'Norwegian',
  PH: 'Filipino', PL: 'Polish', PT: 'Portuguese', PTBR: 'Portuguese (Brazil)', RO: 'Romanian',
  RU: 'Russian', TH: 'Thai', TR: 'Turkish', UA: 'Ukrainian',
};
export const languageLabel = (code) => LANGUAGE_NAMES[code.toUpperCase()] || code;

// Parse an ItemName file into Map<itemNameLower, displayName>. `isJson` picks the B42 path.
export function parseItemNames(text, isJson) {
  const map = new Map();
  const add = (rawKey, value) => {
    if (!rawKey || value == null) return;
    const key = String(rawKey).replace(/^ItemName_/i, '');
    const dot = key.indexOf('.');
    const item = dot >= 0 ? key.slice(dot + 1) : key;
    if (item) map.set(item.toLowerCase(), String(value));
  };
  if (isJson) {
    try {
      const obj = JSON.parse(text);
      if (obj && typeof obj === 'object') {
        for (const [k, v] of Object.entries(obj)) if (typeof v === 'string') add(k, v);
        return map;
      }
    } catch { /* malformed JSON: fall through to the lenient scan below */ }
  }
  // B41 .txt (or a JSON file we could not JSON.parse): scan `key = "val"` / `"key": "val"` pairs,
  // keeping only keys that look like an item translation (an ItemName_ prefix or a dotted fullType).
  const re = /"?((?:ItemName_)?[A-Za-z0-9_][\w.]*)"?\s*[:=]\s*"((?:\\.|[^"\\])*)"/g;
  let m;
  while ((m = re.exec(text))) {
    if (!/ItemName_|\./.test(m[1])) continue;
    add(m[1], m[2].replace(/\\"/g, '"').replace(/\\n/g, ' ').replace(/\\\\/g, '\\'));
  }
  return map;
}

// Case-insensitively find the real-cased Translate dir path in a source, or null.
async function translateDir(source) {
  let real = '';
  for (const seg of LANG_SEGS) {
    const entries = await source.listDir(real);
    const hit = entries.find((e) => e.kind === 'dir' && e.name.toLowerCase() === seg);
    if (!hit) return null;
    real = real ? `${real}/${hit.name}` : hit.name;
  }
  return real;
}

// The ItemName file (json or txt) inside a Translate/<LANG> dir, as { rel, isJson } or null.
function itemNameFile(files) {
  const json = files.find((e) => e.kind === 'file' && e.name.toLowerCase() === 'itemname.json');
  if (json) return { name: json.name, isJson: true };
  const txt = files.find((e) => e.kind === 'file' && /^itemname(_[a-z0-9]+)?\.txt$/i.test(e.name));
  return txt ? { name: txt.name, isJson: false } : null;
}

// Read one source's ItemName dict for a language, or null if that source has none for it.
async function readLangDict(source, tdir, lang) {
  const entries = await source.listDir(tdir);
  const langDir = entries.find((e) => e.kind === 'dir' && e.name.toLowerCase() === lang.toLowerCase());
  if (!langDir) return null;
  const dirRel = `${tdir}/${langDir.name}`;
  const file = itemNameFile(await source.listDir(dirRel));
  if (!file) return null;
  try { return parseItemNames(await source.readText(`${dirRel}/${file.name}`), file.isJson); }
  catch { return null; }
}

// The app keys held items by their MODEL name, but translations key by the ITEM name. Item scripts
// tie the two together via `WeaponSprite = <model>`, so build model -> item to resolve held items.
// (Item-script `DisplayName` is deliberately NOT used: it was deprecated in B42 in favour of the
// translation files - 0 of B42's item scripts even set it - and can be stale/misleading.)
const modelMapCache = new WeakMap(); // scriptFiles array -> itemByModel, so switching languages doesn't re-parse
function buildModelItemMap(scriptFiles) {
  if (!scriptFiles) return new Map();
  const cached = modelMapCache.get(scriptFiles);
  if (cached) return cached;
  const itemByModel = new Map(); // modelLower -> itemLower
  for (const f of scriptFiles || []) {
    let blocks; try { blocks = parseScriptText(f.text); } catch { continue; }
    walkBlocks(blocks, (b) => {
      if (b.type !== 'item' || !b.name) return;
      const ws = prop(b, 'WeaponSprite');
      if (ws) { const model = ws.split('.').pop().toLowerCase(); if (model && !itemByModel.has(model)) itemByModel.set(model, b.name.toLowerCase()); }
    });
  }
  modelMapCache.set(scriptFiles, itemByModel);
  return itemByModel;
}

// Variants inherit their base item's name: bags carried in a hand (Bag_X_LHand/_RHand) and food
// states (BaconStrip_Hand, Apple_Rotten, X_HandCooked...).
const stripStateSuffix = (n) => n
  .replace(/_(L|R)Hand$/i, '')
  .replace(/_(Ground|Hand)(Cooked|Rotten|Burnt|Overdone|Stale)?$/i, '')
  .replace(/_(Cooked|Rotten|Burnt|Overdone|Stale)$/i, '');

// Discover every language that has item translations in ANY source (for the picker). Cheap: only
// directory listings, no file reads of the (large) translation bodies.
export async function listLanguages(index) {
  const sources = (index && index.sources) || index || [];
  const langs = new Set();
  await Promise.all((sources || []).map(async (src) => {
    const tdir = await translateDir(src);
    if (!tdir) return;
    const entries = await src.listDir(tdir);
    await Promise.all(entries.filter((e) => e.kind === 'dir').map(async (e) => {
      if (itemNameFile(await src.listDir(`${tdir}/${e.name}`))) langs.add(e.name.toUpperCase());
    }));
  }));
  return [...langs].sort((a, b) => (a === 'EN' ? -1 : b === 'EN' ? 1 : 0) || languageLabel(a).localeCompare(languageLabel(b)));
}

// Build the display-name lookup for a language. Mirrors the game's fallback chain per item:
//   chosen language -> English (per key, so a partly-translated language still names everything) ->
//   the item script's English DisplayName -> null (caller shows the raw name).
// Translations resolve per-source (each mod in its own files) with vanilla as the shared fallback.
//   get(name, modName) -> display name string, or null
export async function loadItemNames(index, lang) {
  const sources = (index && index.sources) || [];
  const want = (lang || 'EN').toUpperCase();
  const byMod = new Map(); // modName|null -> Map(itemLower -> display), English overlaid with `want`
  await Promise.all(sources.map(async (src) => {
    const tdir = await translateDir(src);
    if (!tdir) return;
    const en = await readLangDict(src, tdir, 'EN');
    let dict;
    if (want === 'EN') dict = en;
    else {
      const langDict = await readLangDict(src, tdir, want);
      if (langDict && en) { dict = new Map(en); for (const [k, v] of langDict) dict.set(k, v); } // English base, chosen language wins
      else dict = langDict || en;
    }
    if (!dict || !dict.size) return;
    const modKey = src.isMod ? (src.modName || src.id) : null;
    const existing = byMod.get(modKey);
    if (existing) for (const [k, v] of dict) { if (!existing.has(k)) existing.set(k, v); }
    else byMod.set(modKey, dict);
  }));
  const vanilla = byMod.get(null) || new Map();
  const itemByModel = buildModelItemMap(index && index.scriptFiles);
  const total = [...byMod.values()].reduce((n, d) => n + d.size, 0);
  return {
    lang: want,
    size: total,
    get(name, modName) {
      if (!name) return null;
      const mod = modName != null ? byMod.get(modName) : null;
      // each combined dict already folds English UNDER the chosen language, so one lookup covers
      // "chosen language, else English" per key.
      const look = (n) => { const kk = n.toLowerCase(); return (mod && mod.get(kk)) || vanilla.get(kk) || null; };
      // The app keys items by their clothing/model name, which can differ from the ITEM name a
      // translation is stored under. Try progressively-normalised candidates, most specific first,
      // and take the first that resolves - so a real match wins before any heuristic strip.
      const cands = [];
      const add = (n) => { if (n && !cands.includes(n)) cands.push(n); };
      add(name);                                              // direct (clothing; held model == item)
      const item = itemByModel.get(name.toLowerCase());
      if (item) add(item);                                    // held: model -> item via WeaponSprite
      add(stripStateSuffix(name));                            // state/hand variants -> base item
      if (item) add(stripStateSuffix(item));
      if (/^bag_/i.test(name)) { const b = name.replace(/^Bag_/i, ''); add(b); add(stripStateSuffix(b)); } // bag model prefix
      for (const c of cands) { const hit = look(c); if (hit) return hit; }
      return null;
    },
  };
}
