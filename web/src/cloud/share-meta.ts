// A small, display-only manifest of what a shared render depicts: the clothing worn, the items
// held, and which mods (if any) they come from. Captured at share time and stored in the
// uploads.meta column, it powers the "Details" panel in the share viewer. Purely informational -
// the server never trusts it for anything.

export interface ShareItem {
  name: string;
  mod: string | null; // the mod it comes from, or null for vanilla Project Zomboid
}
export interface ShareHeldItem extends ShareItem {
  hand: 'left' | 'right';
}

export interface ShareMeta {
  v: 1;
  character?: string; // the character's name, if it has one (imported/saved), for the share viewer + player page
  gender?: 'male' | 'female';
  clothing: ShareItem[];
  held: ShareHeldItem[];
  mods: string[]; // distinct mod names across all equipped items, for a quick "mods used" summary
}

// A share row's meta may be absent (older shares) or, defensively, malformed. Narrow to a usable
// ShareMeta or null so the viewer can cleanly show a "no details" state.
export function normalizeShareMeta(raw: unknown): ShareMeta | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Partial<ShareMeta>;
  if (!Array.isArray(m.clothing) && !Array.isArray(m.held)) return null;
  return {
    v: 1,
    character: typeof m.character === 'string' ? m.character : undefined,
    gender: m.gender === 'female' ? 'female' : m.gender === 'male' ? 'male' : undefined,
    clothing: Array.isArray(m.clothing) ? m.clothing : [],
    held: Array.isArray(m.held) ? m.held : [],
    mods: Array.isArray(m.mods) ? m.mods : [],
  };
}

// base64(UTF-8 JSON), safe to carry in an HTTP header (the X-Share-Meta upload header).
export function encodeShareMeta(meta: ShareMeta): string {
  const bytes = new TextEncoder().encode(JSON.stringify(meta));
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
