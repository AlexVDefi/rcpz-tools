// User-configurable settings (camera controls, keybinds, pose-editor node style) with a tiny
// localStorage-backed pub/sub store. The SettingsModal writes here; the engine, orbit controls and
// the keybind handler read here and re-apply on change. Defaults reproduce the shipped behaviour.

export type CamButton = 'left' | 'right' | 'middle';
export type Bind = { key: string; ctrl?: boolean; shift?: boolean; alt?: boolean };
export type NodeRole = 'ik' | 'pole' | 'aim' | 'move' | 'free';

export type Settings = {
  camera: { orbit: CamButton; pan: CamButton; rotateSpeed: number; zoomSpeed: number; invertZoom: boolean };
  keys: Record<string, Bind>;
  nodes: { scale: number; opacity: number; selectedOpacity: number; colors: Record<NodeRole, string> };
  devMode: boolean; // reveal extra developer/debug buttons in the UI
};

export const KEY_ACTIONS: { id: string; label: string; def: Bind }[] = [
  { id: 'undo', label: 'Undo', def: { key: 'z', ctrl: true } },
  { id: 'redo', label: 'Redo', def: { key: 'y', ctrl: true } },
  { id: 'savePose', label: 'Save pose', def: { key: 's', ctrl: true } },
  { id: 'duplicate', label: 'Duplicate prop', def: { key: 'd', ctrl: true } },
  { id: 'copyKeys', label: 'Copy keyframes', def: { key: 'c', ctrl: true } },
  { id: 'pasteKeys', label: 'Paste keyframes', def: { key: 'v', ctrl: true } },
  { id: 'delete', label: 'Delete selection', def: { key: 'Delete' } },
  { id: 'deselect', label: 'Deselect / cancel', def: { key: 'Escape' } },
  { id: 'playPause', label: 'Play / pause clip', def: { key: ' ' } },
  { id: 'stepPrev', label: 'Previous frame', def: { key: 'ArrowLeft' } },
  { id: 'stepNext', label: 'Next frame', def: { key: 'ArrowRight' } },
  { id: 'clipStart', label: 'Go to clip start', def: { key: 'ArrowLeft', shift: true } },
  { id: 'clipEnd', label: 'Go to clip end', def: { key: 'ArrowRight', shift: true } },
];

export const NODE_ROLES: { id: NodeRole; label: string; def: string }[] = [
  { id: 'ik', label: 'Hands & feet', def: '#5b8cff' },
  { id: 'pole', label: 'Elbows & knees', def: '#ff3db1' },
  { id: 'aim', label: 'Torso, head & fingers', def: '#33cc99' },
  { id: 'move', label: 'Hips', def: '#cc66ff' },
  { id: 'free', label: 'Props', def: '#ffb034' },
];

export const DEFAULT_SETTINGS: Settings = {
  camera: { orbit: 'left', pan: 'right', rotateSpeed: 1, zoomSpeed: 1, invertZoom: false },
  keys: Object.fromEntries(KEY_ACTIONS.map((a) => [a.id, { ...a.def }])),
  nodes: { scale: 1, opacity: 0.5, selectedOpacity: 1, colors: Object.fromEntries(NODE_ROLES.map((r) => [r.id, r.def])) as Record<NodeRole, string> },
  devMode: false,
};

const KEY = 'pz-settings';

function clone(s: Settings): Settings { return JSON.parse(JSON.stringify(s)); }

// Merge stored values over the defaults so a newer field (added in an update) is filled in.
function hydrate(raw: unknown): Settings {
  const d = clone(DEFAULT_SETTINGS);
  if (!raw || typeof raw !== 'object') return d;
  const r = raw as Partial<Settings>;
  if (r.camera) Object.assign(d.camera, r.camera);
  if (r.keys) for (const a of KEY_ACTIONS) if (r.keys[a.id]) d.keys[a.id] = { ...r.keys[a.id] };
  if (r.nodes) { if (typeof r.nodes.scale === 'number') d.nodes.scale = r.nodes.scale; if (typeof r.nodes.opacity === 'number') d.nodes.opacity = r.nodes.opacity; if (typeof r.nodes.selectedOpacity === 'number') d.nodes.selectedOpacity = r.nodes.selectedOpacity; if (r.nodes.colors) Object.assign(d.nodes.colors, r.nodes.colors); }
  if (typeof r.devMode === 'boolean') d.devMode = r.devMode;
  return d;
}

let current: Settings = (() => { try { return hydrate(JSON.parse(localStorage.getItem(KEY) || 'null')); } catch { return clone(DEFAULT_SETTINGS); } })();
const listeners = new Set<(s: Settings) => void>();

export function getSettings(): Settings { return current; }
export function subscribeSettings(fn: (s: Settings) => void): () => void { listeners.add(fn); return () => listeners.delete(fn); }
export function setSettings(next: Settings): void {
  current = next;
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* private mode */ }
  for (const fn of listeners) fn(current);
}
export function resetSettings(): void { setSettings(clone(DEFAULT_SETTINGS)); }

/** Does a keyboard event match a bind? Ctrl and Meta are treated as the same "command" modifier. */
export function matchBind(e: KeyboardEvent, b: Bind | undefined): boolean {
  if (!b) return false;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key; // letters case-insensitive; named keys (Delete/Escape) exact
  if (key !== (b.key.length === 1 ? b.key.toLowerCase() : b.key)) return false;
  return !!b.ctrl === (e.ctrlKey || e.metaKey) && !!b.shift === e.shiftKey && !!b.alt === e.altKey;
}

/** Display name for a single key: Space, arrow names, else the key itself (letters upper-cased). */
const keyLabel = (k: string): string => k === ' ' ? 'Space' : k.startsWith('Arrow') ? k.slice(5) : (k.length === 1 ? k.toUpperCase() : k);

/** Human-readable label for a bind, e.g. "Ctrl + D", "Delete", "Shift + Left". */
export function bindLabel(b: Bind | undefined): string {
  if (!b) return '(unset)';
  const parts: string[] = [];
  if (b.ctrl) parts.push('Ctrl');
  if (b.shift) parts.push('Shift');
  if (b.alt) parts.push('Alt');
  parts.push(keyLabel(b.key));
  return parts.join(' + ');
}

export const hexToInt = (h: string): number => parseInt(h.replace('#', ''), 16) >>> 0;
