import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { listClips, listClothing, listHeldItems, listHair, clothingGroup, CLOTHING_GROUP_ORDER, HELD_GROUP_ORDER, SKIN_TONES, attachmentProviders, listZombieSkins, listBodySources, listBodyTextureSources, clothingBodyFit } from '@shared/character-core.js';
import { SLOTS, bodyAttachOptions, slotsFromWorn } from '@shared/attachments.js';
import { CharacterEngine, type Ctx, type AttachOption } from './render/character-engine';

type AttachSlot = { slot: string; options: AttachOption[] };
import { ThumbnailProvider } from './render/thumbnail-provider';
import { ClipPreview } from './render/clip-preview';
import { FloorLibrary } from './render/floor';
import { TileLibrary, type TileCategory } from './render/tiles-lib';
import { AssetGrid, type GridItem } from './AssetGrid';
import { Thumb } from './Thumb';
import { exportPng, exportGif, exportVideo, download, type BgConfig, type Content } from './render/export-media';
import { discoverSaves, importCharacter, type SaveEntry, type ParsedChar } from './save/save-import';
import { hasPermission, requestPermission } from './platform/idb';
import { pickDirectory, saveDir, loadDir } from './platform/platform';
import { type AuthState } from './cloud/auth';
import { type UploadRow, type CloudUploads } from './cloud/uploads';
import { uploadRender, playerUrl } from './cloud/api';
import type { ShareMeta } from './cloud/share-meta';
import type { DisplayNames } from './item-names';
import { cloudConfigured, fmtBytes } from './cloud/config';
import { useIsMobile } from './useIsMobile';
const SAVES_KEY = 'pz-saves-folder'; // remembered Zomboid folder for the import dialog (session-scoped, like the game/mods handles)
const TOUR_KEY = 'pz-viewer-tour-done'; // set once the first-time guided tour has been seen

type TourStep = { target: string; title: string; body: string; interactive?: boolean };

const rgb01 = (rgb: number[]) => [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255];
const rgbHex = (rgb: number[]) => '#' + rgb.map((c) => Math.max(0, Math.min(255, c)).toString(16).padStart(2, '0')).join('');
const rgb01Hex = (rgb: number[]) => rgbHex(rgb.map((c) => Math.round(Math.max(0, Math.min(1, c)) * 255)));

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const hexToRgb255 = (hex: string): number[] => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const rgb255Hex = (rgb: number[]) => '#' + rgb.map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0')).join('');
function rgbToHsv([r, g, b]: number[]): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) { if (max === r) h = ((g - b) / d) % 6; else if (max === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h *= 60; if (h < 0) h += 360; }
  return [h, max ? d / max : 0, max];
}
function hsvToRgb([h, s, v]: number[]): number[] {
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; } else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; } else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}
// Drag over an element -> fractional (x,y) in [0,1], with pointer capture so it keeps tracking outside.
function startDrag(e: React.PointerEvent, onFrac: (fx: number, fy: number) => void) {
  const el = e.currentTarget as HTMLElement, rect = el.getBoundingClientRect();
  const at = (cx: number, cy: number) => onFrac(clamp01((cx - rect.left) / rect.width), clamp01((cy - rect.top) / rect.height));
  at(e.clientX, e.clientY);
  try { el.setPointerCapture(e.pointerId); } catch { /* older browsers */ }
  const mv = (ev: PointerEvent) => at(ev.clientX, ev.clientY);
  const up = () => { el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); };
  el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
}
function LinkIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1" />
      <path d="M15 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1" />
    </svg>
  );
}

// A compact colour picker. The trigger is just the swatch; clicking opens a popover with a
// saturation/value box, a hue slider, and a HEX field shown by DEFAULT (one tap toggles to RGB) - the
// point being the value reads as hex the moment it opens, not buried in the OS dialog. An optional
// "match" checkbox lives inside the popover (the beard uses it to follow the hair): while on, the colour
// controls lock and follow their source, but the checkbox stays live so you can unlock them.
function ColorPicker({ value, onChange, title, match }: { value: string; onChange: (hex: string) => void; title?: string; match?: { on: boolean; onToggle: (on: boolean) => void; label: string } }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', h);
    return () => document.removeEventListener('pointerdown', h);
  }, [open]);
  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      <button type="button" title={title} onClick={() => setOpen((o) => !o)}
        style={{ position: 'relative', width: 30, height: 30, borderRadius: 6, border: '1px solid var(--line)', background: value, cursor: 'pointer', padding: 0 }}>
        {match?.on && <span style={{ position: 'absolute', right: -4, bottom: -4, width: 15, height: 15, borderRadius: '50%', background: 'var(--accent)', color: '#fff', display: 'grid', placeItems: 'center', border: '1px solid var(--panel)' }}><LinkIcon size={9} /></span>}
      </button>
      {open && <ColorPopover value={value} onChange={onChange} match={match} />}
    </div>
  );
}
function ColorPopover({ value, onChange, match }: { value: string; onChange: (hex: string) => void; match?: { on: boolean; onToggle: (on: boolean) => void; label: string } }) {
  const [hsv, setHsv] = useState<[number, number, number]>(() => rgbToHsv(hexToRgb255(value)));
  const [mode, setMode] = useState<'hex' | 'rgb'>('hex'); // HEX shown by default
  const [hexText, setHexText] = useState(value);
  const locked = !!match?.on;
  useEffect(() => { setHexText(rgb255Hex(hsvToRgb(hsv))); }, [hsv]);
  const emit = (next: [number, number, number]) => { setHsv(next); onChange(rgb255Hex(hsvToRgb(next))); };
  const [h, s, v] = hsv;
  const rgb = hsvToRgb(hsv).map((c) => Math.round(c));
  const commitHex = (raw: string) => { let t = raw.trim(); if (t && t[0] !== '#') t = '#' + t; if (/^#[0-9a-fA-F]{6}$/.test(t)) emit(rgbToHsv(hexToRgb255(t))); else setHexText(rgb255Hex(hsvToRgb(hsv))); };
  const setChan = (i: number, val: number) => { const n = [...rgb]; n[i] = Math.max(0, Math.min(255, Math.round(val) || 0)); emit(rgbToHsv(n)); };
  const numStyle: React.CSSProperties = { width: 44, fontSize: 12, fontFamily: 'ui-monospace, monospace', color: 'var(--text)', background: '#14141a', border: '1px solid var(--line)', borderRadius: 4, padding: '3px 4px', textAlign: 'center' };
  return (
    <div style={{ position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 40, width: 196, padding: 10, background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 8, boxShadow: '0 8px 24px #000a' }}>
      {match && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer', marginBottom: 9 }}>
          <input type="checkbox" checked={match.on} onChange={(e) => match.onToggle(e.target.checked)} style={{ accentColor: 'var(--accent)' }} />
          {match.label}
        </label>
      )}
      <div style={{ opacity: locked ? 0.4 : 1, pointerEvents: locked ? 'none' : 'auto' }}>
        <div onPointerDown={(e) => startDrag(e, (fx, fy) => emit([h, fx, 1 - fy]))}
          style={{ position: 'relative', width: '100%', height: 120, borderRadius: 6, cursor: 'crosshair', touchAction: 'none',
            background: `linear-gradient(to top, #000, rgba(0,0,0,0)), linear-gradient(to right, #fff, hsl(${h}, 100%, 50%))` }}>
          <span style={{ position: 'absolute', left: `${s * 100}%`, top: `${(1 - v) * 100}%`, width: 12, height: 12, transform: 'translate(-50%,-50%)', borderRadius: '50%', border: '2px solid #fff', boxShadow: '0 0 0 1px #0008', pointerEvents: 'none' }} />
        </div>
        <div onPointerDown={(e) => startDrag(e, (fx) => emit([fx * 360, s, v]))}
          style={{ position: 'relative', width: '100%', height: 14, marginTop: 9, borderRadius: 7, cursor: 'ew-resize', touchAction: 'none',
            background: 'linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)' }}>
          <span style={{ position: 'absolute', left: `${(h / 360) * 100}%`, top: '50%', width: 12, height: 12, transform: 'translate(-50%,-50%)', borderRadius: '50%', border: '2px solid #fff', boxShadow: '0 0 0 1px #0008', pointerEvents: 'none' }} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 9 }}>
          <button type="button" onClick={() => setMode((m) => (m === 'hex' ? 'rgb' : 'hex'))} title="Switch HEX / RGB"
            style={{ fontSize: 10, fontWeight: 600, letterSpacing: '.03em', padding: '4px 6px', borderRadius: 4, border: '1px solid var(--line)', background: 'var(--panel)', color: 'var(--muted)', cursor: 'pointer', flexShrink: 0 }}>{mode.toUpperCase()}</button>
          {mode === 'hex' ? (
            <input value={hexText} spellCheck={false} maxLength={7} aria-label="hex colour"
              onChange={(e) => setHexText(e.target.value)} onBlur={(e) => commitHex(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
              style={{ flex: 1, minWidth: 0, fontSize: 12, fontFamily: 'ui-monospace, monospace', color: 'var(--text)', background: '#14141a', border: '1px solid var(--line)', borderRadius: 4, padding: '3px 6px' }} />
          ) : (
            <div style={{ display: 'flex', gap: 4 }}>
              {[0, 1, 2].map((i) => (
                <input key={i} type="number" min={0} max={255} value={rgb[i]} aria-label={['red', 'green', 'blue'][i]}
                  onChange={(e) => setChan(i, Number(e.target.value))} style={numStyle} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

type CamPreset = 'orbit' | 'iso' | 'front' | 'portrait';
const ASPECTS: [string, number | null][] = [['Fit', null], ['1:1', 1], ['4:5', 4 / 5], ['3:4', 3 / 4], ['16:9', 16 / 9], ['9:16', 9 / 16]];
const evenDims = (aspect: number, base: number): [number, number] => {
  let w = base, h = Math.round(base / aspect);
  if (aspect < 1) { h = base; w = Math.round(base * aspect); }
  return [w - (w % 2), h - (h % 2)];
};
const bgStyle = (b: BgConfig): React.CSSProperties =>
  b.mode === 'transparent' ? { backgroundImage: 'repeating-conic-gradient(#3a3a44 0% 25%, #23232b 0% 50%)', backgroundSize: '22px 22px' }
  : b.mode === 'solid' ? { background: b.color1 }
  : { background: `linear-gradient(${b.angle}deg, ${b.color1}, ${b.color2})` };

type Tab = 'animate' | 'clothing' | 'held' | 'character' | 'build' | 'export';
type FavKind = 'clothing' | 'held' | 'hair' | 'beard';
type Light = { ambient: number; keyBright: number; kx: number; ky: number; kz: number };
type ScenePreset = { bg: BgConfig; turntable: boolean; camPreset: CamPreset; studioAspect: number | null; facing: number | null; floor: string | null; light: Light; grid: boolean; shadow: boolean };
type CharPreset = {
  name: string; gender: 'male' | 'female'; skin: string; thumb?: string; // thumb = data-URL preview
  hair: { sel: string; color: string }; beard: { sel: string; color: string };
  clothing: { name: string; tint: number[] | null; hidden: boolean }[];
  held: { name: string; hand: 'right' | 'left'; hidden: boolean; attachments: { slot: string; option: AttachOption }[] }[];
  // items attached to the body (gun in a holster, weapon on back/belt, light on webbing, ...). Stored
  // minimally as slot+name; the exact location/transform is recomputed from the item + worn clothing on load.
  bodyAttachments?: { slot: string; name: string }[];
  scene: ScenePreset;
};
// Auto-saved working character (localStorage). Stored WITHOUT the thumb data-URL, so it stays a few
// KB - no bloat - and a single key that's overwritten, never accumulated. Restored on next open.
const AUTOSAVE_KEY = 'pz-char-autosave';
const readAutosave = (): CharPreset | null => { try { const r = localStorage.getItem(AUTOSAVE_KEY); return r ? (JSON.parse(r) as CharPreset) : null; } catch { return null; } };
const favKey = (kind: FavKind, name: string) => `${kind}:${name}`;
// Curated material presets: each scatters random variants into a baked, non-repetitive floor.
// blends_natural_01 is grouped in 16-index material blocks; the SOLID tiles are at offsets
// {0,5,6,7} per block (the others are transparent edge blends). Blocks: 0=sand, 16&32=grass,
// 48=dry grass, 64=dirt, 112=mud (verified from the in-game lawn reference).
const P = (base: string, ...idx: number[]) => idx.map((i) => `${base}_${i}`);
const NB = (b: number) => [b, b + 5, b + 6, b + 7].map((i) => `blends_natural_01_${i}`);
const FLOOR_PRESETS: [string, string[]][] = [
  ['Grass', [...NB(16), ...NB(32)]],
  ['Dry grass', NB(48)],
  ['Dirt', NB(64)],
  ['Sand', NB(0)],
  ['Asphalt', P('floors_exterior_street_01', 0, 1, 2, 3, 4, 5, 6, 7, 8)],
  ['Wood', P('floors_interior_tilesandwood_01', 47)],
];
interface Clip { id: string; name: string; actor: string; format: string; isMod: boolean; rel: string; modName?: string | null }
interface HairStyle { name: string; model?: string; texture?: string; isMod?: boolean; modName?: string | null }
interface HairData { hair: { male: HairStyle[]; female: HairStyle[] }; beards: HairStyle[] }
type HairItem = HairStyle & GridItem;

const firstLetter = (s: string) => (/[a-z]/i.test(s[0]) ? s[0].toUpperCase() : '#');

// Coarse clip category from the name (for the animation-grid facet).
function clipCategory(name: string): string {
  const n = name.toLowerCase();
  if (/aim/.test(n)) return 'Aim';
  if (/attack|swipe|stab|shoot|melee|slash|\bhit/.test(n)) return 'Attack';
  if (/reload|rack|chamber|bolt/.test(n)) return 'Reload';
  if (/walk/.test(n)) return 'Walk';
  if (/\brun/.test(n)) return 'Run';
  if (/sneak|crouch/.test(n)) return 'Sneak';
  if (/\bsit/.test(n)) return 'Sit';
  if (/climb|vault|fence/.test(n)) return 'Climb';
  if (/fall|trip/.test(n)) return 'Fall';
  if (/death|die|dead/.test(n)) return 'Death';
  if (/react|damage|bitten|bite/.test(n)) return 'React';
  if (/idle/.test(n)) return 'Idle';
  if (/turn/.test(n)) return 'Turn';
  return 'Other';
}

// Lucide icons for the mobile canvas overlay buttons (Equipped = shirt, Scene = sun).
function ShirtIcon({ size = 18 }: { size?: number }) {
  return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20.38 3.46 16 2a4 4 0 0 1-8 0L3.62 3.46a2 2 0 0 0-1.34 2.23l.58 3.47a1 1 0 0 0 .99.84H6v10c0 1.1.9 2 2 2h8a2 2 0 0 0 2-2V10h2.15a1 1 0 0 0 .99-.84l.58-3.47a2 2 0 0 0-1.34-2.23z" /></svg>;
}
function SunIcon({ size = 18 }: { size?: number }) {
  return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2" /><path d="M12 20v2" /><path d="m4.93 4.93 1.41 1.41" /><path d="m17.66 17.66 1.41 1.41" /><path d="M2 12h2" /><path d="M20 12h2" /><path d="m6.34 17.66-1.41 1.41" /><path d="m19.07 4.93-1.41 1.41" /></svg>;
}
function EyeIcon({ size = 20 }: { size?: number }) {
  return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0" /><circle cx="12" cy="12" r="3" /></svg>;
}
function EyeOffIcon({ size = 20 }: { size?: number }) {
  return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" /><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" /><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" /><line x1="2" x2="22" y1="2" y2="22" /></svg>;
}
function BodyIcon({ size = 16 }: { size?: number }) {
  return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="4.5" r="1.6" /><path d="m9 20 3-6 3 6" /><path d="m5.5 8.5 6.5 2 6.5-2" /><path d="M12 10.5v3.5" /></svg>;
}
function GearIcon({ size = 16 }: { size?: number }) {
  return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" /><circle cx="12" cy="12" r="3" /></svg>;
}
function ChevronIcon({ dir, size = 16 }: { dir: 'up' | 'down'; size?: number }) {
  return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={dir === 'up' ? 'm18 15-6-6-6 6' : 'm6 9 6 6 6-6'} /></svg>;
}
function RestartIcon({ size = 16 }: { size?: number }) {
  return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /></svg>;
}

export function CharacterViewer({ ctx, index, onCharacterName, auth, onRequestSignIn, uploads, displayNames, onOpenShared }: { ctx: Ctx; index: unknown; onCharacterName?: (name: string | null) => void; auth: AuthState; onRequestSignIn: () => void; uploads: CloudUploads; displayNames: DisplayNames | null; onOpenShared?: () => void }) {
  const isMobile = useIsMobile();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<CharacterEngine | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const startedRef = useRef(false);
  const pendingImportRef = useRef<ParsedChar | null>(null);
  const applyLookRef = useRef<((p: ParsedChar) => Promise<void>) | null>(null);
  // current character name (from an import or a saved preset), tracked so a share can record it
  const charNameRef = useRef<string | null>(null);
  const emitCharName = (n: string | null) => { charNameRef.current = n; onCharacterName?.(n); };
  const [importOpen, setImportOpen] = useState(false);
  // Restore the last worked-on character: seed gender/skin from the autosave so the first body load
  // frames the right body, and queue the full look as a pending preset the load effect applies.
  const bootChar = useRef<CharPreset | null>(readAutosave());
  const [gender, setGender] = useState<'male' | 'female'>(bootChar.current?.gender || 'male');
  const [skin, setSkin] = useState<string>(bootChar.current?.skin || (SKIN_TONES as Record<string, string[]>)[bootChar.current?.gender || 'male'][0]);
  const tones = (SKIN_TONES as Record<string, string[]>)[gender];
  // Zombie ("Zed") body skins, discovered from the assets (vanilla + mods) for the current gender.
  const [zombieSkins, setZombieSkins] = useState<string[]>([]);
  useEffect(() => { let ok = true; (async () => { try { const z = await listZombieSkins(ctx, gender); if (ok) setZombieSkins(z as string[]); } catch { /* ignore */ } })(); return () => { ok = false; }; }, [ctx, gender]);
  // Body model source: a "body mod" replaces the default MaleBody/FemaleBody (same file name), so more
  // than one source can provide it. Let the user pick which body to use (Vanilla vs the mod's), and
  // remember it globally (it's a viewing preference, not part of a saved character).
  type BodySource = { id: string; label: string; isMod: boolean; srcRef: unknown; realPath: string; format: string };
  const [bodySources, setBodySources] = useState<BodySource[]>([]);
  const [bodySourceId, setBodySourceId] = useState<string>(() => localStorage.getItem('pz-body-source') || '');
  // Tier-2 UV verdict for the loaded body: null when vanilla, else { score, compatible } comparing its UV
  // layout to vanilla's. compatible=false means painted (composite) clothing and stock skins may not align.
  const [uvVerdict, setUvVerdict] = useState<{ score: number; compatible: boolean } | null>(null);
  useEffect(() => { localStorage.setItem('pz-body-source', bodySourceId); }, [bodySourceId]);
  useEffect(() => { let ok = true; (async () => { try { const b = await listBodySources(ctx, gender); if (ok) setBodySources(b as BodySource[]); } catch { /* ignore */ } })(); return () => { ok = false; }; }, [ctx, gender]);
  // Skin-texture source: a texture/skin mod ships its own Body/<tone>.png, so the same tone can come
  // from Vanilla or a mod. Pick which one to paint; remembered globally (a viewing preference). Switching
  // is live (setSkin recomposites), so it is NOT a dep of the body-load effect - a ref feeds the boot path.
  type TexSource = { id: string; label: string; isMod: boolean; srcRef: unknown };
  const [texSources, setTexSources] = useState<TexSource[]>([]);
  const [texSourceId, setTexSourceId] = useState<string>(() => localStorage.getItem('pz-texture-source') || '');
  const texSourceIdRef = useRef(texSourceId);
  useEffect(() => { texSourceIdRef.current = texSourceId; localStorage.setItem('pz-texture-source', texSourceId); }, [texSourceId]);
  useEffect(() => { let ok = true; (async () => { try { const t = await listBodyTextureSources(ctx, gender); if (ok) setTexSources(t as TexSource[]); } catch { /* ignore */ } })(); return () => { ok = false; }; }, [ctx, gender]);
  const skinUrlCache = useRef<Map<string, string>>(new Map());
  useEffect(() => () => { for (const u of skinUrlCache.current.values()) URL.revokeObjectURL(u); }, []);
  const skinThumbUrl = async (name: string): Promise<string> => {
    const cache = skinUrlCache.current;
    const cached = cache.get(name); if (cached) return cached;
    const t = await (ctx.resolver as { resolveTexture(n: string): Promise<{ src: { readBytes(p: string): Promise<Uint8Array> }; realPath: string } | null> }).resolveTexture(`Body/${name}`);
    if (!t) return '';
    const b = await t.src.readBytes(t.realPath);
    const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
    const url = URL.createObjectURL(new Blob([ab], { type: 'image/png' }));
    cache.set(name, url); return url;
  };
  const [status, setStatus] = useState('loading body…');
  const [nowPlaying, setNowPlaying] = useState('');
  const [playing, setPlaying] = useState(true);
  const [tab, setTab] = useState<Tab>('character');
  const [equipTick, setEquipTick] = useState(0);
  const [, setBusy] = useState('');
  const [panelW, setPanelW] = useState(() => Number(localStorage.getItem('pz-panel-w')) || 480);
  // mobile: the tabbed panel is a bottom drawer over a full-height canvas; keep the latest isMobile in
  // a ref so the async body-load can frame the camera for the current form factor without re-running.
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [peeking, setPeeking] = useState(false); // press-and-hold to momentarily hide the drawer and see the character
  useEffect(() => { if (!drawerOpen) setPeeking(false); }, [drawerOpen]);
  const [mobileViewH, setMobileViewH] = useState(0);
  const isMobileRef = useRef(isMobile); isMobileRef.current = isMobile;
  const [clothOnBody, setClothOnBody] = useState(true);
  const [hidePainted, setHidePainted] = useState(false); // Tier-2: on a custom-UV body, drop composite (painted) items that won't align
  // A colour chosen for a tintable garment before it is worn. The thumbnail swatch is always shown for
  // tintable items (so it's clear what's tintable while browsing); picking a colour on an un-worn item
  // stashes it here and it's applied the moment the garment is equipped.
  const [pendingTints, setPendingTints] = useState<Record<string, number[]>>({});
  const [favs, setFavs] = useState<Set<string>>(() => { try { return new Set(JSON.parse(localStorage.getItem('pz-favorites') || '[]') as string[]); } catch { return new Set(); } });
  useEffect(() => { localStorage.setItem('pz-favorites', JSON.stringify([...favs])); }, [favs]);
  const toggleFav = (kind: FavKind, name: string) => setFavs((s) => { const n = new Set(s); const k = favKey(kind, name); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  // hair/beard selection lifted here so the Character tab and the Favorites tab agree on it
  const [hairSel, setHairSel] = useState('None');
  const [beardSel, setBeardSel] = useState('None');
  const [hairColor, setHairColor] = useState('#5a3a20');
  const [beardColor, setBeardColor] = useState('#5a3a20');
  const [equipOpen, setEquipOpen] = useState(false);
  const [sceneOpen, setSceneOpen] = useState(false); // the scene/lighting menu over the display view
  const [attachOpen, setAttachOpen] = useState<string | null>(null); // held item whose attachment picker is expanded
  // studio / export
  const [camPreset, setCamPreset] = useState<CamPreset>('orbit');
  const [studioAspect, setStudioAspect] = useState<number | null>(null);
  const [bg, setBg] = useState<BgConfig>(BG_DEFAULT);
  const [turntable, setTurntable] = useState(false);
  const [gifMode, setGifMode] = useState<'clip' | 'fixed'>('clip');
  const [mp4Seconds, setMp4Seconds] = useState(10);
  const [viewfinder, setViewfinder] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const [exporting, setExporting] = useState<{ label: string; progress: number } | null>(null);
  const [loop, setLoop] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [camMode, setCamMode] = useState<'orbit' | 'iso'>('orbit');
  const [isoMenuOpen, setIsoMenuOpen] = useState(true); // mobile: whether the iso facing compass is expanded
  const [facing, setFacing] = useState<number | null>(0);
  const [light, setLight] = useState<Light>({ ...LIGHT_DEFAULT });
  const [grid, setGrid] = useState(true);
  const [shadow, setShadow] = useState(true);
  const setL = (k: keyof Light, v: number) => { setLight((s) => ({ ...s, [k]: v })); engineRef.current?.setLight(k, v); };
  const [presets, setPresets] = useState<Record<string, CharPreset>>(() => { try { return JSON.parse(localStorage.getItem('pz-char-presets') || '{}'); } catch { return {}; } });
  useEffect(() => { localStorage.setItem('pz-char-presets', JSON.stringify(presets)); }, [presets]);
  const [presetsOpen, setPresetsOpen] = useState(false);
  const pendingPresetRef = useRef<CharPreset | null>(bootChar.current); // restore the autosaved look on first load
  const applyPresetLookRef = useRef<((p: CharPreset) => Promise<void>) | null>(null);
  const initedGenderRef = useRef<string | null>(null); // gender whose body has had its look applied (avoids a re-run wiping it)
  const bootedRef = useRef(false); // first body load + restore done -> safe to start auto-saving
  const scrubRef = useRef<HTMLInputElement>(null);
  const scrubbingRef = useRef(false);

  const clips: Clip[] = useMemo(() => listClips(index), [index]);
  const clipItems = useMemo(() => clips.map((c) => ({ ...c, key: c.id, label: c.name, facet: clipCategory(c.name), source: c.modName || 'Vanilla' })), [clips]);
  const [currentClipId, setCurrentClipId] = useState<string | null>(null);
  // Each item's shown label is its translated display name when one is available (else the raw
  // item/model name). `search` keeps the raw name (and mod) matchable so people can still search by
  // the internal name. `display` is the translated name (or undefined) for capturing into a share.
  // The modded bodies in play (Vanilla excluded): used to tag clothing that is made for a given body,
  // so a "fits <body>" filter appears. Empty when no body mod is loaded, so the tag/filter stays hidden.
  const bodyMods = useMemo(() => bodySources.filter((b) => b.isMod).map((b) => ({ label: b.label, modId: (b as { modId?: string | null }).modId || null, infoId: (b as { infoId?: string | null }).infoId || null })), [bodySources]);
  const clothing = useMemo(() => (listClothing(index) as Array<{ name: string; kind: string; location: string; isMod: boolean; modName?: string | null; allowTint?: boolean; allowHue?: boolean; modId?: string | null; requires?: string[]; maleModel?: string; femaleModel?: string }>)
    .map((c) => { const display = displayNames?.get(c.name, c.modName) || undefined; const label = display || c.name;
      const bodyFit = clothingBodyFit(c, bodyMods) as string[]; // modded bodies this garment is made for
      return { ...c, key: c.name, label, display, bodyFit, search: `${label} ${c.name} ${c.modName || ''}`.toLowerCase(), facet: clothingGroup(c), source: c.modName || 'Vanilla' }; }), [index, displayNames, bodyMods]);
  // A garment is tintable exactly when the game says so: AllowRandomTint or AllowRandomHue (its base
  // texture is greyscale/white and takes a colour multiply). Only these get a colour picker.
  const tintableClothing = useMemo(() => new Set(clothing.filter((c) => c.allowTint || c.allowHue).map((c) => c.name)), [clothing]);
  // On a custom-UV body, painted-on (composite) clothing is drawn through the body's UV map and won't
  // line up; offer to hide it. Only meaningful when the current body's UV layout diverges from vanilla.
  const uvIncompatible = !!uvVerdict && !uvVerdict.compatible;
  const clothingShown = useMemo(() => (uvIncompatible && hidePainted ? clothing.filter((c) => c.kind !== 'composite') : clothing), [clothing, uvIncompatible, hidePainted]);
  const held = useMemo(() => (listHeldItems(index) as Array<{ name: string; mesh: string; texture?: string; scale?: number; isMod?: boolean; modName?: string | null; group: string; tags: string[]; attachSlots?: AttachSlot[]; attachmentType?: string | null; allAttachments?: Record<string, { offset: number[]; rotate: number[]; scale?: number }> }>)
    .map((h) => { const display = displayNames?.get(h.name, h.modName) || undefined; const label = display || h.name;
      return { ...h, key: h.name, label, display, search: `${label} ${h.name} ${h.modName || ''} ${(h.tags || []).join(' ')}`.toLowerCase(), facet: h.group, isMod: !!h.isMod, source: h.modName || 'Vanilla' }; }), [index, displayNames]);
  // raw item/model name -> shown label, so the Equipped panel and shares can display translated names too
  const nameToLabel = useMemo(() => { const m = new Map<string, string>(); for (const c of clothing) m.set(c.name, c.label); for (const h of held) m.set(h.name, h.label); return m; }, [clothing, held]);
  const heldSlots = useMemo(() => { const m = new Map<string, AttachSlot[]>(); for (const h of held) if (h.attachSlots?.length) m.set(h.name, h.attachSlots); return m; }, [held]);

  // ---- body attachments (weapons/gear on the player: bat on back, gun in a worn holster, ...) ----
  // A held-capable item can sit in a hand OR at a body location. The placement control lives on the
  // item itself (Equipped panel + Held browser), mirroring the L/R hand toggle - there is no separate
  // "attach" panel; picking a location just moves the item there.
  type HeldItem = (typeof held)[number];
  type BodyOpt = { slotType: string; slotName: string; location: string; attachmentName: string; transform: { bone: string; offset: number[]; rotate: number[]; scale?: number } };
  const [cardLoc, setCardLoc] = useState<{ item: HeldItem; x: number; y: number } | null>(null); // Held-card location popout
  const providers = useMemo(() => attachmentProviders(index) as Map<string, { provided: string[]; replacement: string | null }>, [index]);
  // Which slots are on the body: Back always, the rest only when the worn clothing provides them.
  // Studio deviation: the small-belt slots are always available too. In the game they need a worn belt
  // (only ~7 belt/tool-rig items provide them), but for a posing tool we always allow belt-valid tools
  // (hammer/knife/screwdriver/wrench/...) on the belt. Item-type validity still applies (a bat can't
  // belt), and holster/webbing/bedroll stay gated behind their items.
  const worn = useMemo(() => {
    const w = slotsFromWorn((engineRef.current?.clothingState() || []).map((c: { name: string }) => c.name), providers);
    w.provided.add('SmallBeltLeft'); w.provided.add('SmallBeltRight');
    return w;
  }, [providers, equipTick]);
  const availableSlots = useMemo(() => Object.entries(SLOTS).filter(([type, s]) => (s as { always?: boolean }).always || worn.provided.has(type)) as [string, { name: string; always?: boolean }][], [worn]);
  const heldByName = useMemo(() => { const m = new Map<string, HeldItem>(); for (const h of held) m.set(h.name, h); return m; }, [held]);
  // Valid body locations for each held item under the currently-worn clothing (items with none omitted).
  const optsByItem = useMemo(() => {
    const m = new Map<string, BodyOpt[]>();
    for (const h of held) {
      if (!h.attachmentType) continue;
      const opts = bodyAttachOptions(h.attachmentType, { provided: worn.provided, hasBag: worn.hasBag, gender }) as BodyOpt[];
      if (opts.length) m.set(h.name, opts);
    }
    return m;
  }, [held, worn, gender]);
  // Taking off the clothing that provided a slot removes whatever was attached there (like the game).
  useEffect(() => {
    const avail = new Set(availableSlots.map(([t]) => t));
    for (const b of engineRef.current?.bodyAttachState() ?? []) if (!avail.has(b.slotType)) engineRef.current?.detachFromBody(b.slotType);
  }, [availableSlots]);
  // Move an item to a body location (leaving the hand if it was held there, like the game).
  const placeOnBody = (item: HeldItem, slotType: string) => guard(async () => {
    const opt = (optsByItem.get(item.name) || (bodyAttachOptions(item.attachmentType!, { provided: worn.provided, hasBag: worn.hasBag, gender }) as BodyOpt[])).find((o) => o.slotType === slotType);
    if (!opt) return;
    if (engineRef.current!.isHeld(item.name)) await engineRef.current!.toggleHeld(item); // take it out of the hand first
    await engineRef.current!.attachToBody(item, slotType, opt.attachmentName, opt.transform);
  });
  // Return a body-attached item to the hand.
  const returnToHand = (item: HeldItem, slotType: string) => guard(async () => {
    engineRef.current!.detachFromBody(slotType);
    if (!engineRef.current!.isHeld(item.name)) await engineRef.current!.toggleHeld(item);
  });
  const detachBody = (slotType: string) => guard(async () => { engineRef.current!.detachFromBody(slotType); });
  const hairData = useMemo(() => listHair(index) as HairData, [index]);

  const idleClip = useMemo(() =>
    clips.find((c) => c.name === 'Bob_Idle') || clips.find((c) => /^bob_idle\b/i.test(c.name)) || clips.find((c) => c.actor.toLowerCase() === 'bob' && /idle/i.test(c.name)),
    [clips]);
  const thumbs = useMemo(() => new ThumbnailProvider(ctx, idleClip), [ctx, idleClip]);
  useEffect(() => () => thumbs.dispose(), [thumbs]);
  const preview = useMemo(() => new ClipPreview(ctx), [ctx]);
  useEffect(() => () => preview.dispose(), [preview]);
  const floorLib = useMemo(() => new FloorLibrary(ctx.resolver as ConstructorParameters<typeof FloorLibrary>[0]), [ctx]);
  const [floorSel, setFloorSel] = useState<string | null>(null);
  // Scene builder: curated vanilla tiles (needs the packs, so local game-files mode). Indexed lazily
  // the first time the Build tab opens. selectedTile is the brush for the (upcoming) placement step.
  const tileLib = useMemo(() => new TileLibrary(ctx.resolver as ConstructorParameters<typeof TileLibrary>[0]), [ctx]);
  const [tileReady, setTileReady] = useState<boolean | 'error'>(false);
  const [tileCat, setTileCat] = useState<TileCategory>('floor');
  const [selectedTile, setSelectedTile] = useState<string | null>(null);
  useEffect(() => {
    if (tab !== 'build' || tileReady) return;
    let ok = true;
    tileLib.ensure().then(() => { if (ok) setTileReady(true); }).catch(() => { if (ok) setTileReady('error'); });
    return () => { ok = false; };
  }, [tab, tileLib, tileReady]);
  const tileItems = useMemo(() => (tileReady === true
    ? tileLib.list(tileCat).map((t) => ({ ...t, key: t.name, label: `${t.sheet.replace(/^(floors_|walls_|furniture_|appliances_|lighting_)/, '')} ${t.index}`, facet: t.sheet, isMod: false }))
    : []), [tileReady, tileLib, tileCat]);
  // The placement brush: a selected floor/rug becomes a de-sheared flat tile you click onto the iso
  // grid. Walls/furniture (standing sprites) aren't placeable yet, so they clear the brush. Leaving
  // the Build tab clears it too. Snap to the PZ-iso camera so what you place reads correctly.
  const selectedTileInfo = selectedTile ? tileLib.get(selectedTile) : undefined;
  const placeableSel = selectedTileInfo?.category === 'floor' || selectedTileInfo?.category === 'overlay';
  useEffect(() => {
    const eng = engineRef.current; if (!eng) return;
    if (tab !== 'build' || !selectedTile || !placeableSel) { eng.setBuildBrush(null); return; }
    let ok = true;
    if (eng.camMode !== 'iso') eng.applyCameraPreset('iso');
    tileLib.flatTexture(selectedTile).then((tex) => { if (ok && tex) eng.setBuildBrush(tex, selectedTileInfo?.category === 'overlay' ? 'rug' : 'floor'); });
    return () => { ok = false; };
  }, [tab, selectedTile, placeableSel, selectedTileInfo, tileLib]);
  // single-tile floor, used when loading a saved character whose floor was a specific tile
  const pickFloor = async (name: string) => { setFloorSel(name); try { engineRef.current?.setFloor(await floorLib.texture(name), 1); } catch { /* ignore */ } };
  const pickPreset = async (name: string, tiles: string[]) => {
    setFloorSel('preset:' + name);
    try {
      // a single-variant preset (e.g. Wood) needs no variation/blend - use the clean single-tile path
      if (tiles.length === 1) engineRef.current?.setFloor(await floorLib.texture(tiles[0]), 1);
      else engineRef.current?.setFloor(await floorLib.presetTexture(tiles, name, 8), 8);
    } catch { /* ignore */ }
  };
  const clearFloor = () => { setFloorSel(null); engineRef.current?.setFloor(null); };
  // scrolling detaches the fixed-position hover preview from its cell - hide it
  useEffect(() => { const off = () => preview.stop(); window.addEventListener('wheel', off, { passive: true }); return () => window.removeEventListener('wheel', off); }, [preview]);
  useEffect(() => { localStorage.setItem('pz-panel-w', String(panelW)); }, [panelW]);


  // engine once; refit the canvas whenever its container resizes (window OR splitter drag)
  useEffect(() => {
    const eng = new CharacterEngine(canvasRef.current!, ctx);
    eng.onClipName = setNowPlaying;
    eng.onFrame = (t, dur) => { const el = scrubRef.current; if (el && !scrubbingRef.current) el.value = String(dur ? (Math.min(t, dur) / dur) * 1000 : 0); };
    eng.onPlaying = setPlaying; // a one-shot clip finishing flips the play/pause button back to play
    eng.onCamMode = setCamMode; // keep the Scene-tab toggle in sync with auto-switches
    eng.onViewfinder = setViewfinder; // studio letterbox rect (CSS px)
    engineRef.current = eng;
    const ro = new ResizeObserver(() => eng.resize());
    if (canvasRef.current?.parentElement) ro.observe(canvasRef.current.parentElement);
    return () => { ro.disconnect(); eng.dispose(); engineRef.current = null; };
  }, [ctx]);

  // Mobile: size the whole character view to the visible viewport below the header, tracking the
  // address-bar show/hide (visualViewport) so the canvas + bottom tab bar always fill the screen.
  useEffect(() => {
    if (!isMobile) { setMobileViewH(0); return; }
    const vv = window.visualViewport;
    const update = () => {
      const top = containerRef.current?.getBoundingClientRect().top ?? 56;
      const vh = vv?.height ?? window.innerHeight;
      setMobileViewH(Math.max(360, Math.round(vh - Math.max(0, top) - 16))); // leave room for the app's bottom padding
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    vv?.addEventListener('resize', update);
    return () => { window.removeEventListener('resize', update); window.removeEventListener('orientationchange', update); vv?.removeEventListener('resize', update); };
  }, [isMobile]);
  // On mobile, keep the whole body auto-framed as the canvas/layout/device-mode changes (until the user
  // adjusts the camera or picks a preset). Off on desktop. Re-applies when the form factor flips.
  useEffect(() => { engineRef.current?.setAutoFrame(isMobile); }, [isMobile]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const eng = engineRef.current; if (!eng) return;
      setStatus('loading body…');
      try {
        // a picked body-model source (a body mod that replaced the default) - discover it fresh for the
        // current gender so gender + body stay in sync; undefined falls back to the mod-over-vanilla default.
        let bodySrc: unknown = undefined;
        if (bodySourceId) { try { const srcs = await listBodySources(ctx, gender); bodySrc = (srcs as { id: string }[]).find((s) => s.id === bodySourceId); } catch { /* default */ } }
        // pin the picked skin-texture source (Vanilla vs a texture mod) before loading so the body paints
        // with it from the first frame. Read via ref (a texture switch is applied live, not by reloading).
        let texSrc: unknown = undefined;
        if (texSourceIdRef.current) { try { const srcs = await listBodyTextureSources(ctx, gender); texSrc = (srcs as { id: string }[]).find((s) => s.id === texSourceIdRef.current); } catch { /* default */ } }
        eng.setTextureSource(texSrc);
        await eng.loadBody(gender, bodySrc);
        if (cancelled) return;
        setUvVerdict(eng.uvVerdict()); // Tier-2: how this body's UV layout compares to vanilla (null when vanilla)
        eng.setAutoFrame(isMobileRef.current); // phone default: whole character centered + fitted, kept on resize
        setStatus(''); setEquipTick((t) => t + 1);
        if (pendingImportRef.current) { const p = pendingImportRef.current; pendingImportRef.current = null; await applyLookRef.current?.(p); }
        else if (pendingPresetRef.current) { const p = pendingPresetRef.current; pendingPresetRef.current = null; await applyPresetLookRef.current?.(p); }
        else if (initedGenderRef.current !== gender) setSkin((SKIN_TONES as Record<string, string[]>)[gender][0]); // fresh gender -> default tone
        // (same gender re-run, e.g. when the idle clip finishes loading, leaves the current look alone)
        initedGenderRef.current = gender; bootedRef.current = true;
        if (!startedRef.current && idleClip) {
          startedRef.current = true;
          try { await eng.playClip(idleClip); setPlaying(true); } catch { /* non-fatal */ }
        }
        // Frame the POSED character on mobile: wait two frames so the idle clip's pose is actually
        // applied (the silhouette fit measures the rendered body, not the un-posed bind geometry).
        if (isMobileRef.current) requestAnimationFrame(() => requestAnimationFrame(() => { if (!cancelled) engineRef.current?.frameToBody(); }));
      } catch (e) { if (!cancelled) setStatus('body error: ' + (e instanceof Error ? e.message : String(e))); }
    })();
    return () => { cancelled = true; };
  }, [gender, idleClip, bodySourceId]);

  async function guard(fn: () => Promise<unknown>) {
    try { await fn(); } catch (e) { setNowPlaying('error: ' + (e instanceof Error ? e.message : String(e))); }
    finally { setBusy(''); setEquipTick((t) => t + 1); }
  }
  const playClip = (c: Clip) => guard(async () => { await engineRef.current!.playClip(c); setPlaying(true); setCurrentClipId(c.id); });
  const toggleCloth = (it: { name: string }) => guard(() => engineRef.current!.toggleClothing(it, pendingTints[it.name] ?? null));
  const setClothTint = (name: string, tint: number[] | null) => guard(() => engineRef.current!.setClothingTint(name, tint));
  // The colour shown on a tintable garment's swatch: the live tint if it's worn, else the pending pick.
  const shownClothTint = (name: string): number[] | null =>
    (engineRef.current?.isEquipped(name) ? engineRef.current?.clothingTint(name) : pendingTints[name]) ?? null;
  // Pick a colour from a thumbnail swatch: remember it, and if the garment is already worn, recolour live.
  const pickClothTint = (name: string, tint: number[]) => {
    setPendingTints((p) => ({ ...p, [name]: tint }));
    if (engineRef.current?.isEquipped(name)) setClothTint(name, tint);
  };
  const toggleHeld = (it: { name: string }) => guard(() => engineRef.current!.toggleHeld(it));
  const setHeldHand = (name: string, hand: 'right' | 'left') => guard(() => engineRef.current!.setHeldHand(name, hand));
  const setAttachment = (name: string, slot: string, option: AttachOption | null) => guard(() => engineRef.current!.setHeldAttachment(name, slot, option));
  const togglePlay = () => { const e = engineRef.current; if (e) setPlaying(e.togglePlay()); };
  // hair/beard apply + recolour (shared by the Character and Favorites tabs)
  const applyHairPart = (kind: 'hair' | 'beard', style: HairStyle) => {
    (kind === 'hair' ? setHairSel : setBeardSel)(style.name);
    engineRef.current?.applyPart(kind, { name: style.name, model: style.model, texture: style.texture }, hexRgb(kind === 'hair' ? hairColor : beardColor)).catch(() => {});
  };
  const recolourPart = (kind: 'hair' | 'beard', hex: string) => {
    (kind === 'hair' ? setHairColor : setBeardColor)(hex);
    engineRef.current?.setPartTint(kind, hexRgb(hex));
    // when the beard is being matched to the hair, a hair recolour drags the beard along
    if (kind === 'hair' && matchBeardRef.current) { setBeardColor(hex); engineRef.current?.setPartTint('beard', hexRgb(hex)); }
  };
  // "match hair" for the beard: keep the beard colour in sync with the hair colour. A ref lets
  // recolourPart read the latest value without being re-created. Turning it on snaps the beard now.
  const [matchBeard, setMatchBeard] = useState(false);
  const matchBeardRef = useRef(matchBeard); matchBeardRef.current = matchBeard;
  const toggleMatchBeard = (on: boolean) => { setMatchBeard(on); if (on) recolourPart('beard', hairColor); };
  // equipped-panel actions
  const toggleHide = (name: string, hidden: boolean) => guard(() => engineRef.current!.setItemHidden(name, hidden));
  const removeEquip = (name: string, type: 'clothing' | 'held') => guard(() => engineRef.current!.removeEquipped(name, type));

  // studio: push camera preset / aspect / turntable into the engine (aspect first so presets reframe)
  useEffect(() => { const e = engineRef.current; if (!e) return; e.setExportAspect(studioAspect); e.applyCameraPreset(camPreset); }, [studioAspect]);
  useEffect(() => {
    engineRef.current?.applyCameraPreset(camPreset);
    // the studio portrait presets look straight at the character, so face them South (toward the camera)
    if (camPreset === 'front' || camPreset === 'portrait') { setFacing(0); engineRef.current?.setFacing(0); }
  }, [camPreset]);
  // Overlay camera buttons apply imperatively (not just via the camPreset effect): dragging in iso
  // silently drifts the engine back to orbit, so re-picking 'iso' must re-apply even though the React
  // camPreset value is unchanged - a plain setCamPreset('iso') would be a no-op and nothing would happen.
  const applyCam = (p: CamPreset) => {
    setCamPreset(p);
    const e = engineRef.current; e?.applyCameraPreset(p);
    if (p === 'front' || p === 'portrait') { setFacing(0); e?.setFacing(0); }
  };
  // Re-clicking the orbit button (already in orbit) snaps back to the default centred view - a quick
  // reset after panning/zooming. Restores auto-framing so mobile gets the tight silhouette fit again.
  const recenterView = () => { setCamPreset('orbit'); const e = engineRef.current; if (!e) return; e.setAutoFrame(isMobile); e.recenter(); };
  useEffect(() => { engineRef.current?.setTurntable(turntable); }, [turntable]);

  // ---- first-time guided tour ----
  const [tourStep, setTourStep] = useState<number | null>(null);
  const tourStartedRef = useRef(false);
  const tourEquippedRef = useRef(false);
  // a recognisable weapon to equip for the demo step, falling back to the first held item
  const tourItem = useMemo(() => held.length
    ? held.find((h) => /baseball ?bat|\bbat\b|\baxe\b|hammer|pistol|revolver|rifle|shotgun|knife|crowbar|\bpan\b|machete/i.test(h.name)) || held[0]
    : null, [held]);
  const tourSteps = useMemo<TourStep[]>(() => [
    { target: '[data-tour="tabs"]', title: 'Build your character here',
      body: 'Every tool lives in these tabs: set the body and skin under Character, then browse Clothing, Held items and Animations. Camera, framing and export options are under Export.' },
    { target: '[data-tour="camera"]', title: 'Orbit or PZ isometric', interactive: true,
      body: 'Switch between free orbit - drag to rotate, scroll to zoom - and the fixed Project Zomboid isometric camera, which adds a facing compass. Try both buttons now; it will not end the tour.' },
    { target: '[data-tour="idle"]', title: 'Back to idle',
      body: 'Once you play an animation, this button snaps the character back to the neutral idle pose at any time.' },
    { target: '[data-tour="equipmenu"]', title: tourItem ? `Equipped ${tourItem.label}` : 'The Equipped panel',
      body: 'We just equipped an item for you. The Equipped panel lists everything worn or held, and lets you switch hands, add attachments, hide, or unequip each one.' },
    { target: '[data-tour="scenemenu"]', title: 'Scene, lighting & floor',
      body: 'Lighting, a floor, and the grid and shadow toggles - all adjustable live here.' },
  ], [tourItem]);

  // start the tour once, for first-time visitors, after the scene is ready. The started latch is
  // set inside the timer (not before it) so StrictMode's mount cleanup can't cancel the only
  // scheduled start - the second mount simply reschedules.
  useEffect(() => {
    if (tourStartedRef.current || localStorage.getItem(TOUR_KEY)) return;
    if (status !== '' || !idleClip || !held.length) return;
    const t = window.setTimeout(() => { if (!tourStartedRef.current) { tourStartedRef.current = true; setTourStep(0); } }, 700);
    return () => clearTimeout(t);
  }, [status, idleClip, held.length]);

  // when the equip step is reached, actually equip the demo item and open the Equipped panel
  useEffect(() => {
    if (tourStep === null || tourSteps[tourStep]?.target !== '[data-tour="equipmenu"]') return;
    if (!tourEquippedRef.current && tourItem && !engineRef.current?.isHeld(tourItem.name)) {
      tourEquippedRef.current = true;
      toggleHeld(tourItem);
    }
    setEquipOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tourStep, tourSteps, tourItem]);

  // when the scene step is reached, open the Scene menu (and close the Equipped panel) so it's shown
  useEffect(() => {
    if (tourStep === null || tourSteps[tourStep]?.target !== '[data-tour="scenemenu"]') return;
    setSceneOpen(true); setEquipOpen(false);
  }, [tourStep, tourSteps]);

  // remember the tour was seen once it closes (finished or skipped)
  useEffect(() => { if (tourStep === null && tourStartedRef.current) localStorage.setItem(TOUR_KEY, '1'); }, [tourStep]);

  const advanceTour = useCallback(() => setTourStep((s) => (s === null || s + 1 >= tourSteps.length ? null : s + 1)), [tourSteps.length]);
  const skipTour = useCallback(() => setTourStep(null), []);

  // Render the current view to a blob for the chosen format (shared by local export + online share).
  const renderBlob = async (kind: 'png' | 'gif' | 'mp4', onProgress: (p: number) => void): Promise<{ blob: Blob; ext: string }> => {
    const eng = engineRef.current!;
    const aspect = studioAspect ?? eng.getCurrentAspect();
    const content: Content = turntable ? 'turntable' : 'anim';
    if (kind === 'png') { const [w, h] = evenDims(aspect, 1080); onProgress(1); return { blob: await exportPng(eng, w, h, bg), ext: 'png' }; }
    if (kind === 'gif') { const [w, h] = evenDims(aspect, 512); return { blob: await exportGif(eng, w, h, bg, { mode: gifMode, seconds: 5, fps: gifMode === 'clip' ? 24 : 15, speed, content, onProgress }), ext: 'gif' }; }
    const [w, h] = evenDims(aspect, 1080); return exportVideo(eng, w, h, bg, { seconds: mp4Seconds, fps: 30, content, onProgress });
  };

  const runExport = async (kind: 'png' | 'gif' | 'mp4') => {
    const eng = engineRef.current; if (!eng || exporting || sharing) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const label = kind === 'png' ? 'PNG' : kind === 'gif' ? 'GIF' : 'video';
    try {
      setExporting({ label, progress: 0 });
      const { blob, ext } = await renderBlob(kind, (p) => setExporting({ label, progress: p }));
      download(blob, `pz-character-${stamp}.${ext}`);
    } catch (e) { setNowPlaying('export error: ' + (e instanceof Error ? e.message : String(e))); }
    finally { setExporting(null); }
  };

  // ---- online sharing (optional; only when signed in) ----
  // The uploads store is owned by App and shared with the Shared tab, so a render shared here shows
  // up there immediately (no page refresh).
  const cloudUploads = uploads;
  const [sharing, setSharing] = useState<{ phase: 'render' | 'upload'; progress: number } | null>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [shareKey, setShareKey] = useState<string | null>(null);
  const [shareErr, setShareErr] = useState('');
  // Snapshot what the render depicts - the visible equipped items and which mod each comes from -
  // so the share viewer can show it. Hidden items are excluded since they aren't in the picture.
  const buildShareMeta = (): ShareMeta => {
    const list = (engineRef.current?.equippedList() ?? []).filter((e) => !e.hidden);
    const modOfClothing = (name: string) => clothing.find((c) => c.name === name)?.modName ?? null;
    const modOfHeld = (name: string) => held.find((h) => h.name === name)?.modName ?? null;
    const disp = (name: string) => { const d = nameToLabel.get(name); return d && d !== name ? d : undefined; };
    const cl = list.filter((e) => e.type === 'clothing').map((e) => ({ name: e.name, display: disp(e.name), mod: modOfClothing(e.name) }));
    const hl = list.filter((e) => e.type === 'held').map((e) => ({ name: e.name, display: disp(e.name), hand: e.hand ?? 'right', mod: modOfHeld(e.name) }));
    const mods = [...new Set([...cl, ...hl].map((x) => x.mod).filter((m): m is string => !!m))];
    return { v: 1, character: charNameRef.current || undefined, gender, clothing: cl, held: hl, mods };
  };
  const shareExport = async (kind: 'png' | 'gif' | 'mp4') => {
    const eng = engineRef.current; if (!eng || sharing || exporting || !auth.session) return;
    setShareErr(''); setShareUrl(null); setShareKey(null);
    try {
      setSharing({ phase: 'render', progress: 0 });
      const meta = buildShareMeta();
      const { blob, ext } = await renderBlob(kind, (p) => setSharing({ phase: 'render', progress: p }));
      setSharing({ phase: 'upload', progress: 0 });
      const res = await uploadRender(auth.session.access_token, blob, { kind, ext, meta, onProgress: (f) => setSharing({ phase: 'upload', progress: f }) });
      setShareUrl(res.url); setShareKey(res.key);
      await cloudUploads.refresh();
    } catch (e) { setShareErr(e instanceof Error ? e.message : String(e)); }
    finally { setSharing(null); }
  };
  const cloud: CloudCtl = {
    signedIn: !!auth.user, ready: auth.ready, onSignIn: onRequestSignIn,
    share: shareExport, sharing, shareUrl, shareKey, sharePlayerUrl: shareKey ? playerUrl(shareKey) : null,
    shareErr, clearResult: () => { setShareUrl(null); setShareKey(null); setShareErr(''); },
    used: cloudUploads.used, limit: cloudUploads.limit, rows: cloudUploads.rows, removeUpload: cloudUploads.remove,
    openShared: onOpenShared,
  };

  // ---- import a character look from a save ----
  const mapSkinTone = (p: ParsedChar, g: 'male' | 'female') => {
    const tones = (SKIN_TONES as Record<string, string[]>)[g];
    if (p.skinTextureName && tones.includes(p.skinTextureName)) return p.skinTextureName;
    let idx = p.skinTexture ?? 0;
    if (g === 'male' && p.bodyHair != null && p.bodyHair !== 255 && idx < 5) idx += 5; // body-hair variant
    return tones[Math.min(Math.max(idx, 0), tones.length - 1)] || tones[0];
  };
  const findHairStyle = (model: string, g: 'male' | 'female') => (g === 'female' ? hairData.hair.female : hairData.hair.male).find((s) => s.model === model || s.name === model);
  const findBeardStyle = (model: string) => hairData.beards.find((s) => s.model === model || s.name === model);
  const findClothingItem = (c: { clothingItemName: string; fullType: string }) =>
    clothing.find((it) => it.name === c.clothingItemName) || clothing.find((it) => c.fullType.toLowerCase().endsWith('.' + it.name.toLowerCase()));

  const applyLook = async (p: ParsedChar) => {
    const eng = engineRef.current; if (!eng) return;
    const g = p.gender || gender;
    const tone = mapSkinTone(p, g);
    if (tone) { setSkin(tone); await eng.setSkin(tone).catch(() => {}); }
    let hairSelName = 'None', hairColorHex = hairColor;
    if (p.hair) {
      const hs = findHairStyle(p.hair.model, g);
      hairSelName = hs?.name || 'None'; setHairSel(hairSelName);
      if (p.hair.color) { hairColorHex = rgbHex(p.hair.color); setHairColor(hairColorHex); }
      await eng.applyPart('hair', hs || { name: 'None' }, p.hair.color ? rgb01(p.hair.color) : null).catch(() => {});
    }
    let beardSelName = 'None', beardColorHex = beardColor;
    if (p.beard && p.beard.model) {
      const bs = findBeardStyle(p.beard.model);
      beardSelName = bs?.name || 'None'; setBeardSel(beardSelName);
      if (p.beard.color) { beardColorHex = rgbHex(p.beard.color); setBeardColor(beardColorHex); }
      await eng.applyPart('beard', bs || { name: 'None' }, p.beard.color ? rgb01(p.beard.color) : null).catch(() => {});
    } else { setBeardSel('None'); await eng.applyPart('beard', { name: 'None' }, null).catch(() => {}); }
    await eng.clearAllClothing();
    let worn = 0;
    for (const c of p.clothing || []) {
      const item = findClothingItem(c);
      if (item) { try { await eng.toggleClothing(item, c.tint ? rgb01(c.tint) : null); worn++; } catch { /* skip */ } }
    }
    setEquipTick((t) => t + 1);
    // an imported save auto-becomes a named saved character, using the survivor's name
    const nm = (p.name || '').trim();
    if (nm) {
      const thumb = capturePreview();
      const preset: CharPreset = {
        name: nm, gender: g, skin: tone || skin, thumb,
        hair: { sel: hairSelName, color: hairColorHex }, beard: { sel: beardSelName, color: beardColorHex },
        clothing: eng.clothingState(), held: eng.heldState(),
        scene: { bg, turntable, camPreset, studioAspect, facing, floor: floorSel, light, grid, shadow },
      };
      setPresets((pr) => ({ ...pr, [nm]: preset }));
      emitCharName(nm);
    } else emitCharName(null);
    setNowPlaying(`imported${nm ? ' & saved ' + nm : ''}: ${worn}/${p.clothing?.length || 0} clothing` + (p.warnings.length ? '. ' + p.warnings.join('; ') : ''));
  };
  applyLookRef.current = applyLook;

  // ---- save / load a full character preset (looks + equipment + scene) ----
  const applyFloor = async (floor: string | null) => {
    if (!floor) { clearFloor(); return; }
    if (floor.startsWith('preset:')) { const nm = floor.slice(7); const p = FLOOR_PRESETS.find(([n]) => n === nm); if (p) await pickPreset(nm, p[1] as string[]); else clearFloor(); }
    else await pickFloor(floor);
  };
  const applyScene = (s: ScenePreset) => {
    const eng = engineRef.current;
    setBg(s.bg); setTurntable(s.turntable); setStudioAspect(s.studioAspect); setCamPreset(s.camPreset);
    setFacing(s.facing); if (s.facing != null) eng?.setFacing(s.facing);
    setLight({ ...s.light }); (['ambient', 'keyBright', 'kx', 'ky', 'kz'] as const).forEach((k) => eng?.setLight(k, s.light[k]));
    setGrid(s.grid); eng?.setGridVisible(s.grid);
    setShadow(s.shadow); eng?.setShadowVisible(s.shadow);
    void applyFloor(s.floor);
  };
  const resetScene = () => applyScene({ ...SCENE_DEFAULT, light: { ...LIGHT_DEFAULT } });

  const findHairByName = (name: string, g: 'male' | 'female') => (g === 'female' ? hairData.hair.female : hairData.hair.male).find((s) => s.name === name);
  const findBeardByName = (name: string) => hairData.beards.find((s) => s.name === name);
  const buildPreset = (name: string): CharPreset => ({
    name, gender, skin,
    hair: { sel: hairSel, color: hairColor }, beard: { sel: beardSel, color: beardColor },
    clothing: engineRef.current?.clothingState() ?? [],
    held: engineRef.current?.heldState() ?? [],
    bodyAttachments: (engineRef.current?.bodyAttachState() ?? []).map((b) => ({ slot: b.slotType, name: b.itemName })),
    scene: { bg, turntable, camPreset, studioAspect, facing, floor: floorSel, light, grid, shadow },
  });
  // Front-35mm portrait snapshot of the current character (facing the camera), for the preset card.
  const capturePreview = (): string | undefined => {
    try { return engineRef.current?.snapshotFront(260, 340, '#1b1d24'); } catch { return undefined; }
  };
  // Switch which body model to use (Vanilla vs a body mod's). Capture the current look first so the
  // body-reload effect re-applies clothing/held/attachments/skin onto the freshly-loaded body.
  const changeBody = (id: string) => {
    if (id === (bodySourceId || bodySources[0]?.id || '')) return;
    pendingPresetRef.current = buildPreset(charNameRef.current || '');
    setBodySourceId(id);
  };
  // Switch which source paints the skin texture (Vanilla vs a texture mod). Applied live - just re-run
  // setSkin with the new source pinned, so no body reload and the clothing/pose stay put.
  const changeTexture = (id: string) => {
    if (id === (texSourceId || texSources[0]?.id || '')) return;
    setTexSourceId(id);
    const eng = engineRef.current; if (!eng) return;
    (async () => {
      try {
        const src = (await listBodyTextureSources(ctx, gender) as { id: string }[]).find((s) => s.id === id);
        eng.setTextureSource(src);
        await eng.setSkin(skin);
      } catch { /* keep the current texture on failure */ }
    })();
  };
  const savePreset = async (name: string) => { const n = name.trim(); if (!n) return; const thumb = capturePreview(); setPresets((p) => ({ ...p, [n]: { ...buildPreset(n), thumb } })); emitCharName(n); };
  const deletePreset = (name: string) => setPresets((p) => { const n = { ...p }; delete n[name]; return n; });
  const duplicatePreset = (preset: CharPreset) => setPresets((p) => {
    const base = preset.name.replace(/ copy( \d+)?$/, '') + ' copy';
    let name = base, i = 2; while (p[name]) name = `${base} ${i++}`;
    return { ...p, [name]: { ...preset, name } };
  });
  // Auto-save the working character (debounced) after any change, once the initial load/restore is
  // done. buildPreset carries no thumb, so the payload is small and the single key is overwritten.
  useEffect(() => {
    if (!bootedRef.current || status) return;
    const id = setTimeout(() => {
      try { localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(buildPreset(charNameRef.current || ''))); } catch { /* quota/serialise - ignore */ }
    }, 500);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gender, skin, hairSel, hairColor, beardSel, beardColor, equipTick, bg, turntable, camPreset, studioAspect, facing, floorSel, light, grid, shadow, status]);
  // Clear the current character to a clean default (keeps gender + scene): the "New character" button.
  const newCharacter = async () => {
    const eng = engineRef.current; if (!eng) return;
    setHairSel('None'); setHairColor('#5a3a20'); setBeardSel('None'); setBeardColor('#5a3a20');
    await eng.applyPart('hair', { name: 'None' }, null).catch(() => {});
    await eng.applyPart('beard', { name: 'None' }, null).catch(() => {});
    await eng.clearAllClothing().catch(() => {});
    await eng.clearAllHeld().catch(() => {});
    eng.clearBodyAttachments();
    const tone0 = (SKIN_TONES as Record<string, string[]>)[gender][0];
    setSkin(tone0); await eng.setSkin(tone0).catch(() => {});
    setEquipTick((t) => t + 1); emitCharName(null); setNowPlaying('new character');
  };
  const applyPresetLook = async (preset: CharPreset) => {
    const eng = engineRef.current; if (!eng) return;
    setSkin(preset.skin); await eng.setSkin(preset.skin).catch(() => {});
    const hs = findHairByName(preset.hair.sel, preset.gender);
    setHairSel(preset.hair.sel); setHairColor(preset.hair.color);
    eng.applyPart('hair', hs || { name: 'None' }, preset.hair.sel === 'None' ? null : hexRgb(preset.hair.color)).catch(() => {});
    const bs = findBeardByName(preset.beard.sel);
    setBeardSel(preset.beard.sel); setBeardColor(preset.beard.color);
    eng.applyPart('beard', bs || { name: 'None' }, preset.beard.sel === 'None' ? null : hexRgb(preset.beard.color)).catch(() => {});
    await eng.clearAllClothing();
    for (const cl of preset.clothing) { const item = clothing.find((x) => x.name === cl.name); if (item) { try { await eng.toggleClothing(item, cl.tint); if (cl.hidden) await eng.setItemHidden(cl.name, true); } catch { /* skip */ } } }
    await eng.clearAllHeld();
    for (const h of preset.held) { const item = held.find((x) => x.name === h.name); if (item) { try { await eng.toggleHeld(item, h.hand); for (const a of h.attachments) await eng.setHeldAttachment(h.name, a.slot, a.option); if (h.hidden) await eng.setItemHidden(h.name, true); } catch { /* skip */ } } }
    // body attachments (gun in holster, weapon on back/belt, light on webbing, ...). Slots depend on the
    // just-restored clothing, so read it straight off the engine (the `worn` memo is stale in this async
    // flow) and recompute each item's location/transform for the restored gender.
    eng.clearBodyAttachments();
    const wornNow = slotsFromWorn((eng.clothingState() || []).map((c: { name: string }) => c.name), providers);
    wornNow.provided.add('SmallBeltLeft'); wornNow.provided.add('SmallBeltRight'); // studio: belt always available
    for (const b of preset.bodyAttachments || []) {
      const item = heldByName.get(b.name);
      if (!item || !item.attachmentType) continue;
      const opt = (bodyAttachOptions(item.attachmentType, { provided: wornNow.provided, hasBag: wornNow.hasBag, gender: preset.gender }) as BodyOpt[]).find((o) => o.slotType === b.slot);
      if (opt) { try { await eng.attachToBody(item, b.slot, opt.attachmentName, opt.transform); } catch { /* skip */ } }
    }
    applyScene(preset.scene);
    setEquipTick((t) => t + 1);
    setNowPlaying(preset.name ? `loaded ${preset.name}` : ''); // an unnamed look is the restored working char
    emitCharName(preset.name || null);
  };
  applyPresetLookRef.current = applyPresetLook;
  const applyPreset = async (preset: CharPreset) => {
    if (preset.gender !== gender) { pendingPresetRef.current = preset; setGender(preset.gender); return; } // effect reloads body, then applies
    await applyPresetLook(preset);
  };

  const applyImport = async (p: ParsedChar) => {
    if (!p.ok && !(p.gender || p.hair || p.clothing?.length)) { setNowPlaying('import failed: ' + (p.warnings.join('; ') || 'could not read character')); return; }
    if (p.gender && p.gender !== gender) { pendingImportRef.current = p; setGender(p.gender); } // effect reloads body, then applies
    else await applyLook(p);
  };

  function startDrag(e: React.MouseEvent) {
    e.preventDefault();
    const container = containerRef.current!;
    const onMove = (ev: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      setPanelW(Math.max(300, Math.min(rect.width - 360, rect.right - ev.clientX)));
    };
    const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); document.body.style.userSelect = ''; };
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  const tabs: [Tab, string][] = [['character', 'Character'], ['clothing', 'Clothing'], ['held', 'Held'], ['build', 'Build'], ['animate', 'Animate'], ['export', 'Export']];
  const segBtn = (on: boolean) => ({ borderRadius: 0, padding: '6px 9px', background: on ? 'var(--accent)' : 'var(--panel)', color: on ? '#fff' : 'var(--muted)' }) as const;
  void equipTick; // re-read equipped state on every equip change
  const equipList = engineRef.current?.equippedList() ?? [];
  void equipTick; // body-attach state below is read fresh each render; equipTick drives re-render
  const bodyEquip = engineRef.current?.bodyAttachState() ?? [];

  // the active tab's content - rendered in the side panel on desktop, in a bottom drawer on mobile
  const panelBody = (
    <div style={{ flex: 1, minHeight: 0 }}>
      {tab === 'animate' && (
        <AssetGrid<typeof clipItems[number] & GridItem>
          items={clipItems as (typeof clipItems[number] & GridItem)[]}
          facetLabel="categories"
          active={(it) => it.id === currentClipId}
          onPick={(it) => playClip(it)}
          renderThumb={(it) => <ClipThumb clip={it} thumbs={thumbs} preview={preview} />} />
      )}
      {tab === 'clothing' && (
        <AssetGrid<typeof clothing[number] & GridItem>
          items={clothingShown as (typeof clothing[number] & GridItem)[]}
          facetLabel="groups"
          facetOrder={CLOTHING_GROUP_ORDER as string[]}
          active={(it) => { void equipTick; return !!engineRef.current?.isEquipped(it.name); }}
          onPick={(it) => toggleCloth(it)}
          favActive={(it) => favs.has(favKey('clothing', it.name))}
          onToggleFav={(it) => toggleFav('clothing', it.name)}
          tagsOf={(it) => it.bodyFit || []}
          overlay={(it) => {
            void equipTick;
            // A "made for <body mod>" badge (top-left, clear of the MOD badge) whenever this garment is
            // associated with a loaded modded body - so it reads at a glance, and the tag dropdown filters by it.
            const fit = it.bodyFit as string[] | undefined;
            const badge = fit && fit.length ? (
              <span title={`Made for: ${fit.join(', ')}`}
                style={{ position: 'absolute', top: 4, left: 4, background: '#5a3e8fcc', color: '#fff', fontSize: 9, padding: '1px 4px', borderRadius: 3, maxWidth: '78%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {fit.length > 1 ? `${fit.length} bodies` : fit[0]}
              </span>
            ) : null;
            // A colour picker in the corner (same spot as the held items' L/R), shown for every garment
            // the game marks tintable - always, not just once worn - so it's clear at a glance while
            // browsing what is and isn't tintable. Picking a colour before wearing is remembered and
            // applied on equip; if it's already worn, the recolour is live.
            const tintable = tintableClothing.has(it.name);
            const cur = tintable ? shownClothTint(it.name) : null;
            const picker = tintable ? (
              <span onClick={(e) => e.stopPropagation()} title={engineRef.current?.isEquipped(it.name) ? 'Tint this garment' : 'Tintable: pick a colour (applied when you wear it)'}
                style={{ position: 'absolute', bottom: 4, right: 4, width: 24, height: 24, borderRadius: 5, overflow: 'hidden', border: '1px solid #000a', boxShadow: '0 1px 2px #000' }}>
                <input type="color" value={cur ? rgb01Hex(cur) : '#ffffff'} onChange={(e) => pickClothTint(it.name, hexRgb(e.target.value))} onClick={(e) => e.stopPropagation()}
                  style={{ position: 'absolute', top: -6, left: -6, width: 36, height: 36, padding: 0, border: 'none', background: 'transparent', cursor: 'pointer' }} />
              </span>
            ) : null;
            if (!badge && !picker) return null;
            return <>{badge}{picker}</>;
          }}
          extraControls={(
            <>
              <div style={{ display: 'flex', border: '1px solid var(--line)', borderRadius: 6, overflow: 'hidden' }} title="thumbnail style">
                <button className="secondary" onClick={() => setClothOnBody(true)} style={segBtn(clothOnBody)}>on body</button>
                <button className="secondary" onClick={() => setClothOnBody(false)} style={segBtn(!clothOnBody)}>item</button>
              </div>
              {uvIncompatible && (
                <button className="secondary" onClick={() => setHidePainted((v) => !v)} style={segBtn(hidePainted)}
                  title="This body has a custom UV layout, so painted-on (composite) clothing will not line up. Hide it.">
                  hide painted-on
                </button>
              )}
            </>
          )}
          renderThumb={(it) => <Thumb depKey={`c:${it.name}:${gender}:${clothOnBody}`} getUrl={() => thumbs.clothing(it, gender, clothOnBody)} />} />
      )}
      {tab === 'held' && (
        <AssetGrid<typeof held[number] & GridItem>
          items={held as (typeof held[number] & GridItem)[]}
          facetLabel="types"
          facetOrder={HELD_GROUP_ORDER as string[]}
          active={(it) => { void equipTick; return !!engineRef.current?.isHeld(it.name) || bodyEquip.some((b) => b.itemName === it.name); }}
          onPick={(it) => toggleHeld(it)}
          favActive={(it) => favs.has(favKey('held', it.name))}
          onToggleFav={(it) => toggleFav('held', it.name)}
          tagsOf={(it) => it.tags}
          overlay={(it) => {
            void equipTick;
            const hand = engineRef.current?.heldHand(it.name);
            const hasLoc = optsByItem.has(it.name); // has valid body location(s) under the worn clothing
            const onBody = bodyEquip.some((b) => b.itemName === it.name);
            if (!hand && !hasLoc) return null;
            return (
              <>
                {hasLoc && (
                  <span role="button" title="Attach to a body location"
                    onClick={(e) => { e.stopPropagation(); const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setCardLoc({ item: it, x: r.left, y: r.bottom + 4 }); }}
                    style={{ position: 'absolute', bottom: 4, left: 4, display: 'grid', placeItems: 'center', width: 24, height: 24, borderRadius: 5, cursor: 'pointer', background: onBody ? 'var(--accent)' : '#0e0e13cc', color: '#fff', border: '1px solid ' + (onBody ? 'var(--accent)' : 'var(--line)'), boxShadow: '0 1px 2px #000' }}>
                    <BodyIcon size={15} />
                  </span>
                )}
                {hand && (
                  <span role="button" title={`held in ${hand} hand (click to switch)`}
                    onClick={(e) => { e.stopPropagation(); setHeldHand(it.name, hand === 'left' ? 'right' : 'left'); }}
                    style={{ position: 'absolute', bottom: 4, right: 4, display: 'grid', placeItems: 'center', width: 24, height: 24, fontSize: 13, fontWeight: 700, lineHeight: 1, borderRadius: 5, cursor: 'pointer', background: 'var(--accent)', color: '#fff', textShadow: '0 1px 2px #000' }}>
                    {hand === 'left' ? 'L' : 'R'}
                  </span>
                )}
              </>
            );
          }}
          renderThumb={(it) => <Thumb depKey={`h:${it.name}`} getUrl={() => thumbs.held(it)} />} />
      )}
      {tab === 'build' && (
        tileReady === 'error' || (tileReady === true && !tileLib.list().length) ? (
          <div style={{ padding: 20, color: 'var(--muted)', fontSize: 13, lineHeight: 1.55 }}>
            Building scenes from tiles reads the vanilla tile packs, which are only available from your
            installed game files. Switch to <b>use my game files</b> (local mode) to browse and place tiles.
            Hosted tile support (a baked curated set) is coming.
          </div>
        ) : tileReady !== true ? (
          <div style={{ padding: 20, color: 'var(--muted)' }}>Indexing tiles…</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
            <div style={{ padding: 8, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', borderBottom: '1px solid var(--line)' }}>
              {tileLib.categories().map((c) => (
                <button key={c} className="secondary" onClick={() => setTileCat(c)}
                  style={{ padding: '6px 12px', borderRadius: 6, textTransform: 'capitalize', background: tileCat === c ? 'var(--accent)' : 'var(--panel)', color: tileCat === c ? '#fff' : 'var(--text)', border: '1px solid var(--line)' }}>
                  {c === 'overlay' ? 'rugs' : c}
                </button>
              ))}
              <button className="secondary" onClick={() => engineRef.current?.clearTiles()} title="Remove every placed tile" style={{ marginLeft: 'auto', padding: '6px 12px', borderRadius: 6, border: '1px solid var(--line)' }}>Clear tiles</button>
            </div>
            <div style={{ flex: 1, minHeight: 0 }}>
              <AssetGrid<typeof tileItems[number] & GridItem>
                key={tileCat}
                items={tileItems as (typeof tileItems[number] & GridItem)[]}
                facetLabel="sheets"
                active={(it) => it.name === selectedTile}
                onPick={(it) => setSelectedTile(it.name === selectedTile ? null : it.name)}
                renderThumb={(it) => <Thumb depKey={`tile:${it.name}`} getUrl={() => tileLib.thumbUrl(it.name)} />} />
            </div>
            <div style={{ padding: '8px 12px', borderTop: '1px solid var(--line)', fontSize: 12, color: 'var(--muted)', lineHeight: 1.4 }}>
              {placeableSel ? <><b style={{ color: 'var(--text)' }}>Click the ground</b> to place. Right-click erases, drag orbits. Floors are the base; rugs stack on top.</>
                : selectedTile ? 'Walls and furniture placement is coming next. Floors and rugs are placeable now.'
                : 'Pick a floor or rug, then click the ground (PZ-iso view) to place it.'}
            </div>
          </div>
        )
      )}
      {tab === 'character' && <CharacterTab hairData={hairData} gender={gender} setGender={setGender} skin={skin} tones={tones} zombieSkins={zombieSkins} skinThumbUrl={skinThumbUrl} bodyOptions={bodySources.map((b) => ({ id: b.id, label: b.label }))} bodySel={bodySourceId || bodySources[0]?.id || ''} onBody={changeBody} uvVerdict={uvVerdict} textureOptions={texSources.map((t) => ({ id: t.id, label: t.label }))} textureSel={texSourceId || texSources[0]?.id || ''} onTexture={changeTexture} onSkin={(t) => { setSkin(t); engineRef.current?.setSkin(t); }} thumbs={thumbs} hairSel={hairSel} beardSel={beardSel} hairColor={hairColor} beardColor={beardColor} matchBeard={matchBeard} onToggleMatchBeard={toggleMatchBeard} onPickPart={applyHairPart} onRecolour={recolourPart} favs={favs} onToggleFav={toggleFav} onImport={() => setImportOpen(true)} onNew={() => { void newCharacter(); }}
        savedCount={Object.keys(presets).length} onOpenSaved={() => setPresetsOpen(true)} />}
      {tab === 'export' && (
        <div style={{ padding: 12, overflow: 'auto', height: '100%' }}>
          <ExportSection cloud={cloud}
            studio={{ camPreset, setCamPreset, studioAspect, setStudioAspect, bg, setBg, turntable, setTurntable, gifMode, setGifMode, mp4Seconds, setMp4Seconds, exporting, runExport }} />
        </div>
      )}
    </div>
  );

  return (
    <div ref={containerRef} style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', gap: isMobile ? 8 : 0, height: isMobile ? (mobileViewH || '80vh') : 'calc(100vh - 128px)', minHeight: isMobile ? 0 : 460 }}>
      {importOpen && <ImportModal onClose={() => setImportOpen(false)} onImport={applyImport} />}
      {presetsOpen && <PresetsModal presets={presets} onClose={() => setPresetsOpen(false)} onSave={savePreset} onLoad={(p) => { void applyPreset(p); setPresetsOpen(false); }} onDelete={deletePreset} onDuplicate={duplicatePreset} />}
      {/* Held-browser location popout: a small menu anchored to the card's attach badge. Fixed-position
          so it never clips inside the grid; a backdrop catches outside clicks. */}
      {cardLoc && (() => {
        const opts = optsByItem.get(cardLoc.item.name) || [];
        const attachedSlot = bodyEquip.find((b) => b.itemName === cardLoc.item.name)?.slotType || null;
        const menuW = 190, rowH = 38;
        const left = Math.max(6, Math.min(cardLoc.x, window.innerWidth - menuW - 6));
        const top = Math.max(6, Math.min(cardLoc.y, window.innerHeight - (opts.length + 1) * rowH - 40));
        return (
          <div onClick={() => setCardLoc(null)} style={{ position: 'fixed', inset: 0, zIndex: 80 }}>{/* above the mobile drawer (z70) so the popout isn't hidden under it */}
            <div onClick={(ev) => ev.stopPropagation()} style={{ position: 'fixed', left, top, width: menuW, background: '#0e0e13f5', border: '1px solid var(--line)', borderRadius: 8, padding: 6, boxShadow: '0 6px 24px #000a' }}>
              <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--muted)', padding: '2px 4px 6px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>Attach {nameToLabel.get(cardLoc.item.name) ?? cardLoc.item.name}</div>
              <button className="secondary" onClick={() => { if (attachedSlot) void returnToHand(cardLoc.item, attachedSlot); setCardLoc(null); }}
                style={{ width: '100%', textAlign: 'left', padding: '9px 10px', marginBottom: 4, fontSize: 12.5, background: attachedSlot ? 'var(--panel)' : 'var(--accent)', color: attachedSlot ? 'var(--text)' : '#fff' }}>In hands</button>
              {opts.map((o) => (
                <button key={o.slotType} className="secondary" title={o.location} onClick={() => { void placeOnBody(cardLoc.item, o.slotType); setCardLoc(null); }}
                  style={{ width: '100%', textAlign: 'left', padding: '9px 10px', marginBottom: 4, fontSize: 12.5, background: o.slotType === attachedSlot ? 'var(--accent)' : 'var(--panel)', color: o.slotType === attachedSlot ? '#fff' : 'var(--text)' }}>{o.slotName}</button>
              ))}
            </div>
          </div>
        );
      })()}
      <div style={{ flex: 1, minHeight: 0, minWidth: isMobile ? 0 : 320, position: 'relative', background: '#14141a', border: '1px solid var(--line)', borderRadius: 8, overflow: 'hidden' }}>
        {/* studio layer: background sits behind the (transparent) WebGL canvas. With a framing
            aspect it's clipped to the viewfinder rect (outside stays the neutral letterbox); in
            "Fit" mode there's no viewfinder, so it fills the whole view. */}
        <div style={{ position: 'absolute', inset: 0 }}>
          <div style={viewfinder
            ? { position: 'absolute', left: viewfinder.left, top: viewfinder.top, width: viewfinder.width, height: viewfinder.height, outline: '1px solid #ffffff2a', ...bgStyle(bg) }
            : { position: 'absolute', inset: 0, ...bgStyle(bg) }} />
          <canvas ref={canvasRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block', touchAction: 'none' }} />
        </div>
        {exporting && (
          <div style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%,-50%)', background: '#000000cc', color: '#fff', padding: '10px 16px', borderRadius: 8, fontSize: 13, zIndex: 5, textAlign: 'center' }}>
            Exporting {exporting.label}… {Math.round(exporting.progress * 100)}%
            {exporting.label === 'video' && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 3 }}>recording in real time</div>}
          </div>
        )}
        <div style={{ position: 'absolute', left: isMobile ? 8 : 12, top: isMobile ? 8 : 12, display: 'flex', gap: isMobile ? 6 : 8, alignItems: 'center', maxWidth: isMobile ? 'calc(100% - 185px)' : undefined }}>
          {status && !isMobile && <span style={{ color: 'var(--muted)', background: '#00000099', padding: '4px 8px', borderRadius: 6 }}>{status}</span>}
          <span style={{ color: 'var(--muted)', background: '#00000099', padding: '4px 8px', borderRadius: 6, fontSize: isMobile ? 11.5 : undefined, maxWidth: isMobile ? '100%' : 340, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{nowPlaying || 'pick a clip →'}</span>
          {idleClip && <button data-tour="idle" className="secondary" title="Reset to idle animation" onClick={() => playClip(idleClip)} style={{ padding: isMobile ? '9px 14px' : '4px 10px', fontSize: isMobile ? 14 : 12, lineHeight: 1, flexShrink: 0 }}>↺ Idle</button>}
        </div>
        <div style={{ position: 'absolute', right: isMobile ? 8 : 12, top: isMobile ? 8 : 12, display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-end' }}>
          <div style={{ display: 'flex', gap: isMobile ? 6 : 8, alignItems: 'flex-start' }}>
            <button className="secondary" title="Equipped items" aria-label="Equipped items" onClick={() => { setEquipOpen((v) => !v); setSceneOpen(false); }}
              style={{ position: 'relative', borderRadius: 6, padding: isMobile ? 0 : '7px 12px', width: isMobile ? 36 : undefined, height: isMobile ? 36 : undefined, display: isMobile ? 'grid' : undefined, placeItems: isMobile ? 'center' : undefined, fontSize: 13, lineHeight: 1, border: '1px solid var(--line)', background: equipOpen ? 'var(--accent)' : 'var(--panel)', color: equipOpen ? '#fff' : 'var(--text)' }}>
              {isMobile ? (<><ShirtIcon />{(equipList.length + bodyEquip.length) > 0 && <span style={{ position: 'absolute', top: -6, right: -6, minWidth: 16, height: 16, padding: '0 4px', borderRadius: 999, background: 'var(--accent)', color: '#fff', fontSize: 10.5, fontWeight: 700, display: 'grid', placeItems: 'center', border: '1.5px solid #0e0e13' }}>{equipList.length + bodyEquip.length}</span>}</>) : `Equipped${(equipList.length + bodyEquip.length) ? ` (${equipList.length + bodyEquip.length})` : ''}`}
            </button>
            <button data-tour="scenebtn" className="secondary" title="Scene, lighting & floor" aria-label="Scene, lighting and floor" onClick={() => { setSceneOpen((v) => !v); setEquipOpen(false); }}
              style={{ borderRadius: 6, padding: isMobile ? 0 : '7px 12px', width: isMobile ? 36 : undefined, height: isMobile ? 36 : undefined, display: isMobile ? 'grid' : undefined, placeItems: isMobile ? 'center' : undefined, fontSize: 13, lineHeight: 1, border: '1px solid var(--line)', background: sceneOpen ? 'var(--accent)' : 'var(--panel)', color: sceneOpen ? '#fff' : 'var(--text)' }}>
              {isMobile ? <SunIcon /> : 'Scene'}
            </button>
            <div data-tour="camera" style={{ display: 'flex', border: '1px solid var(--line)', borderRadius: 6, overflow: 'hidden', height: isMobile ? 36 : undefined }}>
              <button className="secondary" title={camMode === 'orbit' ? 'Free orbit (click again to recenter)' : 'Free orbit'} onClick={() => { if (camMode === 'orbit') recenterView(); else applyCam('orbit'); }}
                style={{ borderRadius: 0, padding: isMobile ? 0 : '5px 11px', width: isMobile ? 36 : undefined, height: isMobile ? '100%' : undefined, display: isMobile ? 'grid' : undefined, placeItems: isMobile ? 'center' : undefined, fontSize: isMobile ? 20 : 24, lineHeight: 1, ...(isMobile ? { border: 'none' } : null), background: camMode === 'orbit' ? 'var(--accent)' : 'var(--panel)', color: camMode === 'orbit' ? '#fff' : 'var(--text)' }}>⟳</button>
              <button className="secondary" title={camMode === 'iso' && isMobile ? (isoMenuOpen ? 'PZ iso (tap to collapse the compass)' : 'PZ iso (tap to open the compass)') : 'PZ iso'}
                onClick={() => { if (camMode !== 'iso') { applyCam('iso'); } else if (isMobile) { setIsoMenuOpen((v) => !v); } else { applyCam('iso'); } }}
                style={{ borderRadius: 0, padding: isMobile ? 0 : '5px 11px', width: isMobile ? 36 : undefined, height: isMobile ? '100%' : undefined, display: isMobile ? 'grid' : undefined, placeItems: isMobile ? 'center' : undefined, fontSize: isMobile ? 20 : 24, lineHeight: 1, ...(isMobile ? { border: 'none', borderLeft: '1px solid var(--line)' } : null), background: camMode === 'iso' ? 'var(--accent)' : 'var(--panel)', color: camMode === 'iso' ? '#fff' : 'var(--text)' }}>◈</button>
            </div>
          </div>
          {/* Mobile: a chevron handle under the iso button, mirroring that tapping the ◈ button
              collapses/expands the compass. Tapping the chevron itself toggles it too. */}
          {isMobile && camMode === 'iso' && (
            <button className="secondary" onClick={() => setIsoMenuOpen((v) => !v)}
              aria-label={isoMenuOpen ? 'Collapse facing compass' : 'Expand facing compass'} title={isoMenuOpen ? 'Collapse facing compass' : 'Expand facing compass'}
              style={{ width: 36, height: 20, padding: 0, display: 'grid', placeItems: 'center', borderRadius: 6, border: '1px solid var(--line)', background: 'var(--panel)', color: 'var(--muted)' }}>
              <ChevronIcon dir={isoMenuOpen ? 'up' : 'down'} size={14} />
            </button>
          )}
          {/* Facing compass: only meaningful under the fixed PZ iso camera, so it appears
              beneath the iso button and hides in free orbit (or when collapsed on mobile). */}
          {camMode === 'iso' && (!isMobile || isoMenuOpen) && (
            <div title="Facing" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 34px)', gap: 3, background: '#0e0e13cc', border: '1px solid var(--line)', borderRadius: 8, padding: 5 }}>
              {FACING_GRID.map((cell, i) => cell === null ? <span key={i} /> : (
                <button key={i} className="secondary" onClick={() => { setFacing(cell[1]); engineRef.current?.setFacing(cell[1]); }}
                  style={{ padding: '6px 0', fontSize: 11, lineHeight: 1, background: facing === cell[1] ? 'var(--accent)' : 'var(--panel)', color: facing === cell[1] ? '#fff' : 'var(--text)' }}>{cell[0]}</button>
              ))}
            </div>
          )}
        </div>
        {equipOpen && (
          <div data-tour="equipmenu" style={{ position: 'absolute', right: isMobile ? 6 : 12, top: isMobile ? 48 : 54, width: isMobile ? 'min(340px, calc(100% - 12px))' : 264, maxHeight: isMobile ? '76%' : '68%', overflow: 'auto', background: '#0e0e13f2', border: '1px solid var(--line)', borderRadius: 8, padding: isMobile ? 10 : 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>Equipped ({equipList.length + bodyEquip.length})</span>
              <span role="button" onClick={() => setEquipOpen(false)} title="close" style={{ cursor: 'pointer', color: 'var(--muted)', padding: '0 4px' }}>✕</span>
            </div>
            {!equipList.length && !bodyEquip.length && <div style={{ color: 'var(--muted)', fontSize: 12, padding: '8px 4px' }}>Nothing equipped.</div>}
            {equipList.map((e) => {
              const slots = e.type === 'held' ? heldSlots.get(e.name) : undefined;
              const locs = e.type === 'held' ? optsByItem.get(e.name) : undefined;
              const open = attachOpen === e.name;
              const chip = (active: boolean): React.CSSProperties => ({ padding: isMobile ? '9px 13px' : '2px 8px', fontSize: isMobile ? 13 : 11, maxWidth: isMobile ? 190 : 118, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', background: active ? 'var(--accent)' : 'var(--panel)', color: active ? '#fff' : 'var(--text)' });
              const actBtn: React.CSSProperties = isMobile ? { padding: '8px 11px', fontSize: 13, lineHeight: 1, borderRadius: 6, flexShrink: 0 } : { padding: '2px 8px', fontSize: 11, flexShrink: 0 };
              const iconBtn: React.CSSProperties = { ...actBtn, display: 'grid', placeItems: 'center', width: isMobile ? 36 : 28, height: isMobile ? 34 : 24, padding: 0 };
              const secLabel: React.CSSProperties = { fontSize: isMobile ? 11 : 10, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--muted)', marginBottom: isMobile ? 7 : 3 };
              const chipRow: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: isMobile ? 8 : 4 };
              return (
                <div key={e.type + ':' + e.name} style={isMobile ? { borderBottom: '1px solid var(--line)', paddingBottom: 5, marginBottom: 5 } : undefined}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: isMobile ? 7 : 6, padding: isMobile ? '6px 2px' : '4px 2px' }}>
                    <span style={{ flex: 1, minWidth: 0, fontSize: isMobile ? 13 : 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', opacity: e.hidden ? 0.45 : 1 }} title={e.name}>{nameToLabel.get(e.name) ?? e.name}</span>
                    <span style={{ fontSize: 9, color: 'var(--muted)', border: '1px solid var(--line)', borderRadius: 3, padding: '0 3px', flexShrink: 0 }}>{e.type === 'held' ? 'held' : 'worn'}</span>
                    {e.type === 'held' && (
                      <button className="secondary" title="Hand, body location and attachments" aria-label="Options" onClick={() => setAttachOpen(open ? null : e.name)}
                        style={{ ...iconBtn, background: open ? 'var(--accent)' : 'var(--panel)', color: open ? '#fff' : 'var(--text)' }}><GearIcon size={isMobile ? 16 : 14} /></button>
                    )}
                    {e.type === 'clothing' && tintableClothing.has(e.name) && (() => {
                      void equipTick;
                      const cur = engineRef.current?.clothingTint(e.name);
                      return (
                        <span title="Tint this garment" style={{ ...iconBtn, position: 'relative', overflow: 'hidden', borderRadius: 6, border: '1px solid var(--line)' }}>
                          <input type="color" value={cur ? rgb01Hex(cur) : '#ffffff'} onChange={(ev) => setClothTint(e.name, hexRgb(ev.target.value))}
                            style={{ position: 'absolute', top: -8, left: -8, width: 'calc(100% + 16px)', height: 'calc(100% + 16px)', padding: 0, border: 'none', background: 'transparent', cursor: 'pointer' }} />
                        </span>
                      );
                    })()}
                    <button className="secondary" title={e.hidden ? 'Show in scene' : 'Hide from scene'} aria-label={e.hidden ? 'show' : 'hide'} onClick={() => toggleHide(e.name, !e.hidden)}
                      style={{ ...iconBtn, color: e.hidden ? 'var(--muted)' : 'var(--text)' }}>{e.hidden ? <EyeOffIcon size={isMobile ? 16 : 14} /> : <EyeIcon size={isMobile ? 16 : 14} />}</button>
                    <button className="secondary" title="remove (unequip)" aria-label="remove" onClick={() => removeEquip(e.name, e.type)} style={{ ...iconBtn, fontSize: isMobile ? 14 : 12, color: '#ff6b6b' }}>✕</button>
                  </div>
                  {open && e.type === 'held' && (
                    <div style={{ padding: isMobile ? '2px 2px 12px 10px' : '2px 2px 8px 8px', margin: '0 0 4px 4px', borderLeft: '2px solid var(--accent)' }}>
                      <div style={{ marginTop: isMobile ? 4 : 2 }}>
                        <div style={secLabel}>Hand</div>
                        <div style={chipRow}>
                          <button className="secondary" onClick={() => setHeldHand(e.name, 'right')} style={chip(e.hand !== 'left')}>Right</button>
                          <button className="secondary" onClick={() => setHeldHand(e.name, 'left')} style={chip(e.hand === 'left')}>Left</button>
                        </div>
                      </div>
                      {locs && locs.length > 0 && (
                        <div style={{ marginTop: isMobile ? 11 : 6 }}>
                          <div style={secLabel}>Body location</div>
                          <div style={chipRow}>
                            <button className="secondary" onClick={() => setAttachOpen(null)} style={chip(true)}>In hands</button>
                            {locs.map((o) => (
                              <button key={o.slotType} className="secondary" title={o.location} onClick={() => { const item = heldByName.get(e.name); if (item) void placeOnBody(item, o.slotType); setAttachOpen(null); }} style={chip(false)}>{o.slotName}</button>
                            ))}
                          </div>
                        </div>
                      )}
                      {slots && slots.map((s) => {
                        void equipTick;
                        const cur = engineRef.current?.heldAttachment(e.name, s.slot) ?? null;
                        return (
                          <div key={s.slot} style={{ marginTop: isMobile ? 11 : 6 }}>
                            <div style={secLabel}>{s.slot}</div>
                            <div style={chipRow}>
                              <button className="secondary" onClick={() => setAttachment(e.name, s.slot, null)} style={chip(cur === null)}>None</button>
                              {s.options.map((o) => (
                                <button key={o.partName} className="secondary" title={o.partName} onClick={() => setAttachment(e.name, s.slot, o)} style={chip(cur === o.partName)}>{o.partName}</button>
                              ))}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
            {bodyEquip.map((b) => {
              const it = heldByName.get(b.itemName);
              const slotName = (SLOTS as Record<string, { name: string }>)[b.slotType]?.name || b.slotType;
              const open = attachOpen === 'body:' + b.slotType;
              const chip = (active: boolean): React.CSSProperties => ({ padding: isMobile ? '9px 13px' : '2px 8px', fontSize: isMobile ? 13 : 11, maxWidth: isMobile ? 190 : 118, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', background: active ? 'var(--accent)' : 'var(--panel)', color: active ? '#fff' : 'var(--text)' });
              const actBtn: React.CSSProperties = isMobile ? { padding: '8px 11px', fontSize: 13, lineHeight: 1, borderRadius: 6, flexShrink: 0 } : { padding: '2px 8px', fontSize: 11, flexShrink: 0 };
              const iconBtn: React.CSSProperties = { ...actBtn, display: 'grid', placeItems: 'center', width: isMobile ? 36 : 28, height: isMobile ? 34 : 24, padding: 0 };
              const secLabel: React.CSSProperties = { fontSize: isMobile ? 11 : 10, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--muted)', marginBottom: isMobile ? 7 : 3 };
              const chipRow: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: isMobile ? 8 : 4 };
              return (
                <div key={'body:' + b.slotType} style={isMobile ? { borderBottom: '1px solid var(--line)', paddingBottom: 5, marginBottom: 5 } : undefined}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: isMobile ? 7 : 6, padding: isMobile ? '6px 2px' : '4px 2px' }}>
                    <span style={{ flex: 1, minWidth: 0, fontSize: isMobile ? 13 : 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={b.itemName}>{nameToLabel.get(b.itemName) ?? b.itemName}</span>
                    <span title={slotName} style={{ fontSize: 9, color: 'var(--muted)', border: '1px solid var(--line)', borderRadius: 3, padding: '0 3px', flexShrink: 0, maxWidth: 96, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{slotName}</span>
                    {it && optsByItem.has(b.itemName) && (
                      <button className="secondary" title="Change hand or body location" aria-label="Placement" onClick={() => setAttachOpen(open ? null : 'body:' + b.slotType)}
                        style={{ ...iconBtn, background: open ? 'var(--accent)' : 'var(--panel)', color: open ? '#fff' : 'var(--text)' }}><GearIcon size={isMobile ? 16 : 14} /></button>
                    )}
                    <button className="secondary" title="remove (detach)" aria-label="remove" onClick={() => detachBody(b.slotType)} style={{ ...iconBtn, fontSize: isMobile ? 14 : 12, color: '#ff6b6b' }}>✕</button>
                  </div>
                  {open && it && (
                    <div style={{ padding: isMobile ? '2px 2px 12px 10px' : '2px 2px 8px 8px', margin: '0 0 4px 4px', borderLeft: '2px solid var(--accent)' }}>
                      <div style={{ marginTop: isMobile ? 4 : 2 }}>
                        <div style={secLabel}>Placement</div>
                        <div style={chipRow}>
                          <button className="secondary" onClick={() => { void returnToHand(it, b.slotType); setAttachOpen(null); }} style={chip(false)}>In hands</button>
                          {(optsByItem.get(b.itemName) || []).map((o) => (
                            <button key={o.slotType} className="secondary" title={o.location} onClick={() => { void placeOnBody(it, o.slotType); setAttachOpen(null); }} style={chip(o.slotType === b.slotType)}>{o.slotName}</button>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {sceneOpen && (
          <div data-tour="scenemenu" style={{ position: 'absolute', right: isMobile ? 6 : 12, top: isMobile ? 48 : 54, width: isMobile ? 'min(300px, calc(100% - 12px))' : 280, maxHeight: '74%', overflow: 'auto', background: '#0e0e13f2', border: '1px solid var(--line)', borderRadius: 8, padding: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>Scene &amp; lighting</span>
              <span role="button" onClick={() => setSceneOpen(false)} title="close" style={{ cursor: 'pointer', color: 'var(--muted)', padding: '0 4px' }}>✕</span>
            </div>
            <SceneControls floorSel={floorSel} onPreset={pickPreset} onClear={clearFloor}
              scene={{ light, setL, grid, setGrid: (v) => { setGrid(v); engineRef.current?.setGridVisible(v); }, shadow, setShadow: (v) => { setShadow(v); engineRef.current?.setShadowVisible(v); }, onReset: resetScene }} />
          </div>
        )}
        <div style={{ position: 'absolute', left: 12, bottom: 12, right: 12, display: 'flex', gap: isMobile ? 6 : 8, alignItems: 'center', background: '#000000aa', borderRadius: 8, padding: isMobile ? '6px 8px' : '6px 10px' }}>
          <button className="secondary" onClick={togglePlay} style={{ padding: isMobile ? '4px 10px' : '4px 12px', flexShrink: 0 }}>{playing ? '❚❚' : '▶'}</button>
          <button className="secondary" title="Play from the start" aria-label="Replay from start" onClick={() => { engineRef.current?.replay(); setPlaying(true); }}
            style={{ padding: 0, width: isMobile ? 32 : 30, height: isMobile ? 30 : 28, display: 'grid', placeItems: 'center', flexShrink: 0 }}><RestartIcon size={isMobile ? 16 : 15} /></button>
          <input ref={scrubRef} type="range" min={0} max={1000} defaultValue={0}
            onMouseDown={() => { scrubbingRef.current = true; }} onMouseUp={() => { scrubbingRef.current = false; }}
            onInput={(e) => engineRef.current?.seek(Number((e.target as HTMLInputElement).value) / 1000)}
            style={{ flex: 1, minWidth: 0, accentColor: '#5b8cff' }} />
          <button className="secondary" onClick={() => { const n = !loop; setLoop(n); engineRef.current?.setLoop(n); }}
            style={{ padding: isMobile ? '4px 9px' : '4px 10px', flexShrink: 0, background: loop ? 'var(--accent)' : 'var(--panel)', color: loop ? '#fff' : 'var(--text)' }}>loop</button>
          <select value={speed} onChange={(e) => { const s = Number(e.target.value); setSpeed(s); engineRef.current?.setSpeed(s); }}
            style={{ background: 'var(--panel)', color: 'var(--text)', border: '1px solid var(--line)', borderRadius: 6, padding: '4px 6px', flexShrink: 0 }}>
            {[0.25, 0.5, 1, 2].map((s) => <option key={s} value={s}>{s}×</option>)}
          </select>
        </div>
      </div>

      {!isMobile && (
        <div onMouseDown={startDrag} title="drag to resize" style={{ width: 12, cursor: 'col-resize', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <div style={{ width: 4, height: 44, borderRadius: 2, background: 'var(--line)' }} />
        </div>
      )}

      {isMobile ? (
        // bottom tab bar: tapping a tab opens the drawer with that tab's content
        <div data-tour="tabs" style={{ display: 'flex', gap: 5, flexShrink: 0, background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 10, padding: 5 }}>
          {tabs.map(([t, label]) => (
            <button key={t} onClick={() => { setTab(t); setDrawerOpen(true); }}
              style={{ flex: 1, minWidth: 0, padding: '9px 2px', fontSize: 11.5, fontWeight: 600, borderRadius: 7, background: 'transparent', color: 'var(--text)', border: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</button>
          ))}
        </div>
      ) : (
        <div style={{ width: panelW, flexShrink: 0, minWidth: 300, display: 'flex', flexDirection: 'column', minHeight: 0, background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 8 }}>
          <TabStrip tabs={tabs} active={tab} onSelect={setTab} />
          {panelBody}
        </div>
      )}

      {isMobile && drawerOpen && (
        <>
        {/* Press-and-hold to momentarily hide the whole drawer and see the character (e.g. the item you
            just equipped); releasing brings it back. Pointer-captured so the release always lands here. */}
        <button
          onPointerDown={(e) => { e.preventDefault(); try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* not supported */ } setPeeking(true); }}
          onPointerUp={() => setPeeking(false)} onPointerCancel={() => setPeeking(false)} onLostPointerCapture={() => setPeeking(false)}
          aria-label="Hold to peek at your character" title="Hold to hide this panel and see your character"
          style={{ position: 'fixed', right: 14, bottom: 'calc(env(safe-area-inset-bottom, 0px) + 14px)', zIndex: 72, width: 42, height: 42, padding: 0, borderRadius: 999, display: 'grid', placeItems: 'center', touchAction: 'none', userSelect: 'none', WebkitUserSelect: 'none', opacity: peeking ? 1 : 0.55, background: peeking ? 'var(--accent)' : '#0e0e13e6', color: peeking ? '#fff' : 'var(--text)', border: '1px solid var(--line)', boxShadow: '0 6px 20px #000a', transition: 'opacity .12s ease, background .12s ease' }}>
          <EyeIcon size={18} />
        </button>
        <div onClick={() => setDrawerOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 70, background: '#0007', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', opacity: peeking ? 0 : 1, pointerEvents: peeking ? 'none' : 'auto', transition: 'opacity .12s ease' }}>
          <div onClick={(e) => e.stopPropagation()} style={{ height: 'min(80vh, 680px)', display: 'flex', flexDirection: 'column', background: 'var(--panel)', borderTop: '1px solid var(--line)', borderRadius: '14px 14px 0 0', overflow: 'hidden', boxShadow: '0 -14px 44px #000a', paddingBottom: 'env(safe-area-inset-bottom)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: 8, borderBottom: '1px solid var(--line)', flexShrink: 0 }}>
              <div className="tabstrip" style={{ display: 'flex', gap: 4, flex: 1, overflowX: 'auto' }}>
                {tabs.map(([t, label]) => (
                  <button key={t} onClick={() => setTab(t)}
                    style={{ flexShrink: 0, padding: '7px 11px', fontSize: 12.5, borderRadius: 7, whiteSpace: 'nowrap', cursor: 'pointer', background: tab === t ? 'var(--accent)' : 'transparent', color: tab === t ? '#fff' : 'var(--muted)', border: `1px solid ${tab === t ? 'var(--accent)' : 'var(--line)'}` }}>{label}</button>
                ))}
              </div>
              <button className="secondary" onClick={() => setDrawerOpen(false)} aria-label="Close" style={{ width: 32, height: 32, padding: 0, display: 'grid', placeItems: 'center', fontSize: 15, flexShrink: 0 }}>✕</button>
            </div>
            {panelBody}
          </div>
        </div>
        </>
      )}

      {tourStep !== null && <ViewerTour steps={tourSteps} step={tourStep} onNext={advanceTour} onSkip={skipTour} />}
    </div>
  );
}

// First-time guided tour: dims the page, spotlights one anchored element per step, and shows a
// tooltip card next to it. Anchors are found by their data-tour attribute and re-measured every
// frame (via rAF) so the spotlight stays glued as the layout shifts (e.g. the Equipped panel
// opening). Clicks on the dimmed area are swallowed so the walkthrough drives the interaction.
function ViewerTour({ steps, step, onNext, onSkip }: { steps: TourStep[]; step: number; onNext: () => void; onSkip: () => void }) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const cur = steps[step];
  const last = step >= steps.length - 1;
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const el = cur ? document.querySelector(cur.target) : null;
      const r = el ? el.getBoundingClientRect() : null;
      setRect((prev) => (prev && r && prev.left === r.left && prev.top === r.top && prev.width === r.width && prev.height === r.height ? prev : r));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [cur]);

  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
  const vw = window.innerWidth, vh = window.innerHeight;
  const cardW = Math.min(320, vw - 24);
  const cardRef = useRef<HTMLDivElement>(null);
  const [cardH, setCardH] = useState(200); // real measured height, so placement never crops the card
  useLayoutEffect(() => { const h = cardRef.current?.offsetHeight; if (h) setCardH(h); }, [cur, cardW]);
  let cardLeft = vw / 2 - cardW / 2, cardTop = vh / 2 - cardH / 2;
  if (rect) {
    const cx = rect.left + rect.width / 2, gap = 22;
    if (vh - rect.bottom >= cardH + gap) { cardTop = rect.bottom + 14; cardLeft = cx - cardW / 2; }          // below the target
    else if (rect.left >= cardW + gap) { cardLeft = rect.left - cardW - 14; cardTop = rect.top; }            // left
    else if (vw - rect.right >= cardW + gap) { cardLeft = rect.right + 14; cardTop = rect.top; }             // right
    else if (rect.top >= cardH + gap) { cardTop = rect.top - 14 - cardH; cardLeft = cx - cardW / 2; }        // above the target
    else { cardTop = vh - cardH - 12; cardLeft = cx - cardW / 2; }                                           // tall target (Scene menu): pin near the bottom
    cardLeft = clamp(cardLeft, 12, vw - cardW - 12);
    cardTop = clamp(cardTop, 12, Math.max(12, vh - cardH - 12));               // always fully on-screen
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 500, pointerEvents: 'none' }}>
      {/* Swallow clicks over the dimmed area so the app stays put while the tour runs. On an
          interactive step, leave a hole over the spotlighted control (a four-rect frame) so the
          user can operate it - e.g. toggle the camera - without the click closing the tour. */}
      {cur?.interactive && rect ? (
        ([
          { left: 0, top: 0, width: vw, height: Math.max(0, rect.top) },
          { left: 0, top: rect.bottom, width: vw, height: Math.max(0, vh - rect.bottom) },
          { left: 0, top: rect.top, width: Math.max(0, rect.left), height: rect.height },
          { left: rect.right, top: rect.top, width: Math.max(0, vw - rect.right), height: rect.height },
        ] as const).map((r, i) => (
          <div key={i} style={{ position: 'fixed', left: r.left, top: r.top, width: r.width, height: r.height, pointerEvents: 'auto' }} onClick={(e) => e.stopPropagation()} />
        ))
      ) : (
        <div style={{ position: 'absolute', inset: 0, pointerEvents: 'auto' }} onClick={(e) => e.stopPropagation()} />
      )}
      {rect && <div style={{ position: 'fixed', left: rect.left - 6, top: rect.top - 6, width: rect.width + 12, height: rect.height + 12,
        borderRadius: 10, boxShadow: '0 0 0 9999px rgba(8, 9, 13, 0.66)', outline: '2px solid var(--accent)', outlineOffset: 2,
        pointerEvents: 'none', transition: 'left .2s ease, top .2s ease, width .2s ease, height .2s ease' }} />}
      <div style={{ position: 'fixed', left: cardLeft, top: cardTop, width: cardW, pointerEvents: 'auto' }}>
        <div ref={cardRef} className="tour-card" style={{ background: 'linear-gradient(180deg, #23232b, #1b1b21)', border: '1px solid var(--line)', borderRadius: 12, padding: '16px 16px 12px', boxShadow: '0 18px 50px #000000aa' }}>
          <div style={{ fontSize: 11, color: 'var(--muted)', letterSpacing: '.04em', marginBottom: 6 }}>STEP {step + 1} OF {steps.length}</div>
          <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>{cur?.title}</div>
          <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.55 }}>{cur?.body}</div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 14 }}>
            <button className="secondary" onClick={onSkip} style={{ padding: '6px 12px', fontSize: 12 }}>Skip</button>
            <button onClick={onNext} style={{ padding: '6px 18px', fontSize: 13, fontWeight: 600 }}>{last ? 'Done' : 'Next'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Panel tab bar. Tabs grow to fill the panel when it's wide enough; when the panel is narrower
// than all tabs they keep their size and the row scrolls horizontally, with a fade + chevron on
// each overflowing edge (click to scroll) so it's obvious there are more tabs off-screen.
function TabStrip({ tabs, active, onSelect }: { tabs: [Tab, string][]; active: Tab; onSelect: (t: Tab) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const update = useCallback(() => {
    const el = ref.current; if (!el) return;
    setEdges({ left: el.scrollLeft > 1, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 1 });
  }, []);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    el.addEventListener('scroll', update, { passive: true });
    return () => { ro.disconnect(); el.removeEventListener('scroll', update); };
  }, [update]);
  // keep the selected tab in view when it changes (e.g. via the guided tour)
  useEffect(() => { ref.current?.querySelector<HTMLButtonElement>(`[data-tab="${active}"]`)?.scrollIntoView({ inline: 'nearest', block: 'nearest' }); }, [active]);
  const nudge = (dir: -1 | 1) => { const el = ref.current; if (el) el.scrollBy({ left: dir * el.clientWidth * 0.7, behavior: 'smooth' }); };
  return (
    <div data-tour="tabs" style={{ position: 'relative', borderBottom: '1px solid var(--line)' }}>
      <div ref={ref} className="tabstrip" style={{ display: 'flex', overflowX: 'auto' }}>
        {tabs.map(([t, label]) => (
          <button key={t} data-tab={t} onClick={() => onSelect(t)} className="secondary"
            style={{ flex: '1 0 auto', whiteSpace: 'nowrap', borderRadius: 0, padding: '8px 12px', fontSize: 12.5, background: active === t ? 'var(--accent)' : 'transparent', color: active === t ? '#fff' : 'var(--text)' }}>{label}</button>
        ))}
      </div>
      {edges.left && <button className="tabfade tabfade-l" title="more tabs" aria-label="scroll tabs left" onClick={() => nudge(-1)}>‹</button>}
      {edges.right && <button className="tabfade tabfade-r" title="more tabs" aria-label="scroll tabs right" onClick={() => nudge(1)}>›</button>}
    </div>
  );
}

// Clip grid cell: static thumbnail + hover to play the animation live over the cell.
function ClipThumb({ clip, thumbs, preview }: { clip: { id: string; rel: string; format: string }; thumbs: ThumbnailProvider; preview: ClipPreview }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div ref={ref} style={{ width: '100%', height: '100%' }}
      onMouseEnter={() => { const el = ref.current; if (!el) return; const r = el.getBoundingClientRect(); preview.play(clip, { left: r.left, top: r.top, width: r.width, height: r.height }); }}
      onMouseLeave={() => preview.stop()}>
      <Thumb depKey={`clip:${clip.id}`} getUrl={() => thumbs.clip(clip)} />
    </div>
  );
}

// 3x3 compass; degrees are the character's Y facing. Positions are rotated one step
// clockwise from the cardinal layout so the buttons line up with what's seen in the viewer.
const FACING_GRID: ([string, number] | null)[] = [
  ['W', 90], ['NW', 135], ['N', 180],
  ['SW', 45], null, ['NE', 225],
  ['S', 0], ['SE', 315], ['E', 270],
];
const LIGHT_DEFAULT: Light = { ambient: 0.55, keyBright: 0.5, kx: 0.12, ky: 0.28, kz: 1.0 };
const BG_DEFAULT: BgConfig = { mode: 'solid', color1: '#0d0d0d', color2: '#0a0b10', angle: 90 };
const SCENE_DEFAULT: ScenePreset = { bg: BG_DEFAULT, turntable: false, camPreset: 'orbit', studioAspect: null, facing: 0, floor: null, light: LIGHT_DEFAULT, grid: true, shadow: true };

interface StudioCtl {
  camPreset: CamPreset; setCamPreset: (p: CamPreset) => void;
  studioAspect: number | null; setStudioAspect: (a: number | null) => void;
  bg: BgConfig; setBg: (b: BgConfig) => void;
  turntable: boolean; setTurntable: (v: boolean) => void;
  gifMode: 'clip' | 'fixed'; setGifMode: (m: 'clip' | 'fixed') => void;
  mp4Seconds: number; setMp4Seconds: (n: number) => void;
  exporting: { label: string; progress: number } | null;
  runExport: (kind: 'png' | 'gif' | 'mp4') => void;
}

interface SceneCtl {
  light: Light; setL: (k: keyof Light, v: number) => void;
  grid: boolean; setGrid: (v: boolean) => void;
  shadow: boolean; setShadow: (v: boolean) => void;
  onReset: () => void;
}

// Optional online-sharing controls. Only meaningful when the cloud feature is configured (the
// whole block is hidden otherwise, since the Scene tab passes cloud through unconditionally).
interface CloudCtl {
  signedIn: boolean; ready: boolean; onSignIn: () => void;
  share: (kind: 'png' | 'gif' | 'mp4') => void;
  sharing: { phase: 'render' | 'upload'; progress: number } | null;
  shareUrl: string | null; shareKey: string | null; sharePlayerUrl: string | null; shareErr: string; clearResult: () => void;
  used: number; limit: number; rows: UploadRow[]; removeUpload: (key: string) => void;
  openShared?: () => void;
}

// Scene / lighting / floor controls, shown in the pop-over menu over the display view. Compact and
// self-contained (the pop-over supplies its own padding + heading).
function SceneControls({ floorSel, onPreset, onClear, scene }: {
  floorSel: string | null; onPreset: (name: string, tiles: string[]) => void; onClear: () => void; scene: SceneCtl;
}) {
  const { light, setL, grid, setGrid, shadow, setShadow } = scene;
  const label = { color: 'var(--muted)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '.05em', display: 'block', margin: '12px 0 6px' } as const;
  const slider = (k: keyof Light, name: string, min: number, max: number) => (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 5 }}>
      <span style={{ width: 62, fontSize: 12, color: 'var(--muted)' }}>{name}</span>
      <input type="range" min={min} max={max} step={0.01} value={light[k]} onChange={(e) => setL(k, Number(e.target.value))} style={{ flex: 1, accentColor: '#5b8cff' }} />
      <span style={{ width: 34, fontSize: 11, textAlign: 'right', fontFamily: 'monospace', color: 'var(--muted)' }}>{light[k].toFixed(2)}</span>
    </div>
  );
  const toggle = (on: boolean) => ({ padding: '6px 12px', fontSize: 12, background: on ? 'var(--accent)' : 'var(--panel)', color: on ? '#fff' : 'var(--text)' }) as const;
  return (
    <div>
      <label style={{ ...label, marginTop: 0 }}>Lighting</label>
      {slider('ambient', 'ambient', 0, 1)}
      {slider('keyBright', 'key light', 0, 1)}
      {slider('kx', 'key X', -2, 2)}
      {slider('ky', 'key Y', -2, 2)}
      {slider('kz', 'key Z', -2, 2)}

      <label style={label}>Floor</label>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button className="secondary" onClick={onClear} style={toggle(!floorSel)}>None</button>
        {FLOOR_PRESETS.map(([name, tiles]) => (
          <button key={name} className="secondary" onClick={() => onPreset(name, tiles)} style={toggle(floorSel === 'preset:' + name)}>{name}</button>
        ))}
      </div>

      <label style={label}>Display</label>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="secondary" onClick={() => setGrid(!grid)} style={toggle(grid)} title="Show the floor grid">Floor grid</button>
        <button className="secondary" onClick={() => setShadow(!shadow)} style={toggle(shadow)} title="Cast a shadow under the character">Shadow</button>
      </div>

      <button className="secondary" onClick={scene.onReset} title="Reset lighting, floor and camera to defaults"
        style={{ width: '100%', padding: '8px', marginTop: 14, fontSize: 12 }}>↺ Reset scene</button>
    </div>
  );
}

// Studio / export controls: camera presets, framing aspect (letterboxed viewfinder in the
// live view), background, and the PNG/GIF/MP4 exporters.
function ExportSection({ studio, cloud }: { studio: StudioCtl; cloud: CloudCtl }) {
  const s = studio;
  const busy = !!s.exporting || !!cloud.sharing;
  const label = { color: 'var(--muted)', fontSize: 12, display: 'block', margin: '14px 0 6px' } as const;
  const seg = (on: boolean) => ({ borderRadius: 0, padding: '6px 10px', background: on ? 'var(--accent)' : 'var(--panel)', color: on ? '#fff' : 'var(--muted)', fontSize: 12 }) as const;
  const chip = (on: boolean) => ({ padding: '6px 11px', borderRadius: 6, background: on ? 'var(--accent)' : 'var(--panel)', color: on ? '#fff' : 'var(--text)', fontSize: 12 }) as const;
  const CAMS: [CamPreset, string][] = [['orbit', 'Free'], ['iso', 'PZ iso'], ['front', 'Front 35mm'], ['portrait', 'Portrait 60mm']];

  return (
    <div>
      <div style={{ color: 'var(--muted)', fontSize: 12, lineHeight: 1.5, marginBottom: 2 }}>Camera, framing and background for your render. Scene, lighting and floor live in the <b style={{ color: 'var(--text)' }}>Scene</b> menu over the view.</div>

      <label style={label}>Camera</label>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {CAMS.map(([p, name]) => <button key={p} className="secondary" onClick={() => s.setCamPreset(p)} style={chip(s.camPreset === p)}>{name}</button>)}
      </div>

      <label style={label}>Framing</label>
      <div style={{ display: 'flex', border: '1px solid var(--line)', borderRadius: 6, overflow: 'hidden', width: 'fit-content', flexWrap: 'wrap' }}>
        {ASPECTS.map(([name, a]) => <button key={name} className="secondary" onClick={() => s.setStudioAspect(a)} style={seg(s.studioAspect === a)}>{name}</button>)}
      </div>

      <label style={label}>Background</label>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', border: '1px solid var(--line)', borderRadius: 6, overflow: 'hidden' }}>
          {(['transparent', 'solid', 'gradient'] as const).map((m) => <button key={m} className="secondary" onClick={() => s.setBg({ ...s.bg, mode: m })} style={seg(s.bg.mode === m)}>{m}</button>)}
        </div>
        {s.bg.mode !== 'transparent' && <ColorPicker value={s.bg.color1} onChange={(hex) => s.setBg({ ...s.bg, color1: hex })} title="colour 1" />}
        {s.bg.mode === 'gradient' && <ColorPicker value={s.bg.color2} onChange={(hex) => s.setBg({ ...s.bg, color2: hex })} title="colour 2" />}
        {s.bg.mode === 'gradient' && <input type="range" min={0} max={360} value={s.bg.angle} onChange={(e) => s.setBg({ ...s.bg, angle: Number(e.target.value) })} title="angle" style={{ width: 90, accentColor: '#5b8cff' }} />}
      </div>

      <label style={label}>Motion</label>
      <button className="secondary" onClick={() => s.setTurntable(!s.turntable)} style={chip(s.turntable)}>Turntable spin {s.turntable ? 'on' : 'off'}</button>
      <div style={{ color: 'var(--muted)', fontSize: 11, marginTop: 4 }}>{s.turntable ? '360° spin over the clip length' : 'records the current animation'}</div>

      <label style={label}>Export</label>
      {(() => { const selStyle = { background: '#14141a', color: 'var(--text)', border: '1px solid var(--line)', borderRadius: 6, padding: '6px 8px', fontSize: 12 } as const; const grp = { display: 'flex', border: '1px solid var(--line)', borderRadius: 6, overflow: 'hidden' } as const; return (
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button className="secondary" disabled={busy} onClick={() => s.runExport('png')} style={{ padding: '7px 12px', opacity: busy ? 0.5 : 1 }}>PNG</button>
        <div style={grp}>
          <button className="secondary" disabled={busy} onClick={() => s.runExport('gif')} style={{ borderRadius: 0, border: 0, padding: '7px 12px', opacity: busy ? 0.5 : 1 }}>GIF</button>
          <select value={s.gifMode} onChange={(e) => s.setGifMode(e.target.value as 'clip' | 'fixed')} title="GIF length" style={{ ...selStyle, border: 0, borderLeft: '1px solid var(--line)', borderRadius: 0 }}>
            <option value="clip">Clip loop</option>
            <option value="fixed">5s</option>
          </select>
        </div>
        <div style={grp}>
          <button className="secondary" disabled={busy} onClick={() => s.runExport('mp4')} style={{ borderRadius: 0, border: 0, padding: '7px 12px', opacity: busy ? 0.5 : 1 }}>MP4</button>
          <select value={s.mp4Seconds} onChange={(e) => s.setMp4Seconds(Number(e.target.value))} title="video length" style={{ ...selStyle, border: 0, borderLeft: '1px solid var(--line)', borderRadius: 0 }}>
            {[5, 10, 15, 20, 30].map((n) => <option key={n} value={n}>{n}s</option>)}
          </select>
        </div>
      </div>
      ); })()}
      <div style={{ color: 'var(--muted)', fontSize: 11, marginTop: 6 }}>
        GIF “Clip loop” captures one full loop of the current animation at your chosen playback speed, for seamless loops. Transparent background applies to PNG + GIF; video always uses the chosen colour. Everything is generated in your browser and saved straight to your device.
      </div>

      {cloudConfigured && <ShareSection cloud={cloud} busy={busy} label={label} />}
    </div>
  );
}

// Optional "Share online" block under the exporter: sign-in prompt when logged out; otherwise a
// usage meter, one-click render-and-upload buttons, the resulting share link, the 100 MB
// explainer, and the user's list of shares.
function ShareSection({ cloud, busy, label }: { cloud: CloudCtl; busy: boolean; label: React.CSSProperties }) {
  const over = cloud.used >= cloud.limit;
  // The most recent share: the one just made this session, else the newest stored row (rows are
  // newest-first), so its links persist across reloads. The full history lives in the Shared tab.
  const latest = cloud.shareUrl
    ? { url: cloud.shareUrl, player: cloud.sharePlayerUrl, key: cloud.shareKey }
    : cloud.rows[0]
      ? { url: cloud.rows[0].url, player: playerUrl(cloud.rows[0].key), key: cloud.rows[0].key }
      : null;
  return (
    <div style={{ marginTop: 20, paddingTop: 12, borderTop: '1px solid var(--line)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ color: 'var(--text)', fontSize: 13, fontWeight: 600 }}>Share online</div>
        <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '.05em', color: 'var(--accent)', border: '1px solid var(--line)', borderRadius: 4, padding: '1px 5px' }}>OPTIONAL</span>
      </div>

      {!cloud.ready ? null : !cloud.signedIn ? (
        <div style={{ marginTop: 8 }}>
          <div style={{ color: 'var(--muted)', fontSize: 12, lineHeight: 1.55, marginBottom: 8 }}>
            Sign in to render straight to a shareable link. Everything here works fully offline; this is only for sharing your renders with others.
          </div>
          <button onClick={cloud.onSignIn} style={{ padding: '8px 14px' }}>Sign in to upload &amp; share</button>
        </div>
      ) : (
        <>
          <UsageBar used={cloud.used} limit={cloud.limit} />

          <label style={label}>Upload &amp; share (uses current settings)</label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            {(['png', 'gif', 'mp4'] as const).map((k) => (
              <button key={k} disabled={busy || over} onClick={() => cloud.share(k)}
                style={{ padding: '7px 14px', fontWeight: 600, opacity: (busy || over) ? 0.5 : 1 }}>{k.toUpperCase()}</button>
            ))}
            {cloud.sharing && (
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                <span className="spinner" /> {cloud.sharing.phase === 'render' ? 'Rendering' : 'Uploading'} {Math.round(cloud.sharing.progress * 100)}%
              </span>
            )}
          </div>
          {over && <div style={{ color: '#ffb454', fontSize: 11.5, marginTop: 6 }}>You are at your storage limit. Delete a share to free space.</div>}
          {cloud.shareErr && <div style={{ color: '#ff8a8a', fontSize: 12, marginTop: 6 }}>{cloud.shareErr}</div>}
          {latest && <ShareResult url={latest.url} playerUrl={latest.player} onDelete={async () => { if (latest.key) await cloud.removeUpload(latest.key); cloud.clearResult(); }} />}

          {cloud.openShared && (
            <button className="secondary" onClick={cloud.openShared} style={{ marginTop: 12, padding: '8px 14px', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              View all your shares →
            </button>
          )}

          <div style={{ color: 'var(--muted)', fontSize: 11, lineHeight: 1.55, marginTop: 10 }}>
            Each account gets 100 MB of cloud storage. This is a free web app and I can't afford much storage, so the cap keeps it sustainable. Manage all your shares on the Shared page; you can always export locally (above) too.
          </div>
        </>
      )}
    </div>
  );
}

function UsageBar({ used, limit }: { used: number; limit: number }) {
  const pct = Math.min(100, limit ? (used / limit) * 100 : 0);
  const warn = pct > 85;
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, color: 'var(--muted)', marginBottom: 4 }}>
        <span>Cloud storage used</span>
        <span><b style={{ color: warn ? '#ffb454' : 'var(--text)' }}>{fmtBytes(used)}</b> of {fmtBytes(limit)}</span>
      </div>
      <div style={{ height: 7, background: '#0e0e13', border: '1px solid var(--line)', borderRadius: 999, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: pct + '%', background: warn ? 'linear-gradient(90deg,#e0913a,#ffb454)' : 'linear-gradient(90deg,#4b7bff,#7ea6ff)', transition: 'width .3s' }} />
      </div>
    </div>
  );
}

function ShareResult({ url, playerUrl, onDelete }: { url: string; playerUrl: string | null; onDelete: () => Promise<void> }) {
  const [copied, setCopied] = useState<'' | 'file' | 'player'>('');
  const [deleting, setDeleting] = useState(false);
  const copy = async (which: 'file' | 'player', value: string) => { try { await navigator.clipboard.writeText(value); setCopied(which); setTimeout(() => setCopied(''), 1500); } catch { /* clipboard blocked */ } };
  const del = async () => { setDeleting(true); try { await onDelete(); } catch { setDeleting(false); } };
  const openBtn = { padding: '6px 10px', fontSize: 12, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', borderRadius: 6, border: '1px solid var(--line)', background: 'var(--panel)', color: 'var(--text)' } as const;
  const inputStyle = { flex: 1, minWidth: 0, background: '#14141a', color: 'var(--text)', border: '1px solid var(--line)', borderRadius: 6, padding: '6px 8px', fontSize: 12 } as const;
  const linkLabel = { width: 92, flexShrink: 0, whiteSpace: 'nowrap', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.02em' } as const;
  return (
    <div style={{ marginTop: 10, background: '#0e1524', border: '1px solid #2a3a5a', borderRadius: 8, padding: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--accent)' }}>Most recent share</span>
        <button className="secondary" disabled={deleting} onClick={del} title="delete this share" style={{ padding: '2px 8px', fontSize: 11, color: '#ff6b6b', flexShrink: 0 }}>{deleting ? '…' : 'Delete'}</button>
      </div>
      <div style={{ fontSize: 12, color: '#7ea6ff', fontWeight: 600, lineHeight: 1.45, marginBottom: 8 }}>Share just the raw media file, or a detailed view that shows the equipped gear.</div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <span style={{ ...linkLabel, color: 'var(--muted)' }} title="The raw image or video file on its own">File</span>
        <input readOnly value={url} onFocus={(e) => e.currentTarget.select()} style={inputStyle} />
        <button className="secondary" onClick={() => copy('file', url)} style={{ padding: '6px 10px', fontSize: 12 }}>{copied === 'file' ? 'Copied' : 'Copy'}</button>
        <a href={url} target="_blank" rel="noopener noreferrer" className="secondary" style={openBtn}>Open</a>
      </div>
      {playerUrl && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 6 }}>
          <span style={{ ...linkLabel, color: 'var(--accent)' }} title="A PZ Survivor Studio page showing the render with the character name and equipped gear">Detailed view</span>
          <input readOnly value={playerUrl} onFocus={(e) => e.currentTarget.select()} style={inputStyle} />
          <button className="secondary" onClick={() => copy('player', playerUrl)} style={{ padding: '6px 10px', fontSize: 12 }}>{copied === 'player' ? 'Copied' : 'Copy'}</button>
          <a href={playerUrl} target="_blank" rel="noopener noreferrer" className="secondary" style={openBtn}>Open</a>
        </div>
      )}
    </div>
  );
}

const hexRgb = (hex: string) => { const n = parseInt(hex.slice(1), 16); return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; };
const toHairItem = (s: HairStyle): HairItem => ({ ...s, key: s.name, label: s.name, facet: firstLetter(s.name), isMod: !!s.isMod, source: s.modName || 'Vanilla' });
const NONE_HAIR: HairItem = { name: 'None', key: 'None', label: 'None', facet: '·', isMod: false };

// Character tab: identity (gender + skin texture) as a compact header, then a browsable
// thumbnail grid for the active appearance kind (Hair or Beard) filling the rest. Selection
// and colour are lifted to the parent so the Favorites tab stays in sync.
function CharacterTab({ hairData, gender, setGender, skin, tones, zombieSkins, skinThumbUrl, bodyOptions, bodySel, onBody, uvVerdict, textureOptions, textureSel, onTexture, onSkin, thumbs, hairSel, beardSel, hairColor, beardColor, matchBeard, onToggleMatchBeard, onPickPart, onRecolour, favs, onToggleFav, onImport, onNew, savedCount, onOpenSaved }: {
  hairData: HairData;
  gender: 'male' | 'female';
  setGender: (g: 'male' | 'female') => void;
  skin: string;
  tones: string[];
  zombieSkins: string[];
  skinThumbUrl: (name: string) => Promise<string>;
  bodyOptions: { id: string; label: string }[];
  bodySel: string;
  onBody: (id: string) => void;
  uvVerdict: { score: number; compatible: boolean } | null;
  textureOptions: { id: string; label: string }[];
  textureSel: string;
  onTexture: (id: string) => void;
  onSkin: (tone: string) => void;
  thumbs: ThumbnailProvider;
  hairSel: string;
  beardSel: string;
  hairColor: string;
  beardColor: string;
  matchBeard: boolean;
  onToggleMatchBeard: (on: boolean) => void;
  onPickPart: (kind: 'hair' | 'beard', style: HairStyle) => void;
  onRecolour: (kind: 'hair' | 'beard', hex: string) => void;
  favs: Set<string>;
  onToggleFav: (kind: FavKind, name: string) => void;
  onImport: () => void;
  onNew: () => void;
  savedCount: number;
  onOpenSaved: () => void;
}) {
  const [kind, setKind] = useState<'hair' | 'beard'>('hair');
  const isMobile = useIsMobile(); // phones can't reach local PZ saves, so hide the save-import action

  const hairItems = useMemo(() => [NONE_HAIR, ...(gender === 'female' ? hairData.hair.female : hairData.hair.male).map(toHairItem)], [hairData, gender]);
  const beardItems = useMemo(() => [NONE_HAIR, ...hairData.beards.map(toHairItem)], [hairData]);
  const items = kind === 'hair' ? hairItems : beardItems;
  const selected = kind === 'hair' ? hairSel : beardSel;
  const color = kind === 'hair' ? hairColor : beardColor;

  // 'MaleBody03a' -> '3h' (body-hair variant), 'FemaleBody02' -> '2'
  const toneLabel = (t: string) => { const m = t.match(/(\d+)(a?)$/); return m ? String(parseInt(m[1], 10)) + (m[2] ? 'h' : '') : t; };
  const seg = (on: boolean) => ({ borderRadius: 0, padding: '6px 14px', background: on ? 'var(--accent)' : 'var(--panel)', color: on ? '#fff' : 'var(--muted)' }) as const;
  const chip = (on: boolean) => ({ minWidth: 34, borderRadius: 6, padding: '7px 8px', background: on ? 'var(--accent)' : '#14141a', color: on ? '#fff' : 'var(--text)', border: '1px solid var(--line)' }) as const;
  // Zombie skins get a sickly-green look so they read clearly as separate from the human tones.
  const [zModal, setZModal] = useState(false);
  const ZOMBIE_BUTTONS_MAX = 8; // few -> inline buttons; more (usually modded) -> a browsable modal
  // Label the real B42 zombie skins by rot stage + body variant, e.g. M_ZedBody02_level1 -> "Rot 1 · 2".
  const zombieLabel = (n: string) => {
    const lm = /^[mf]_zedbody0*(\d+)_level([123])$/i.exec(n);
    if (lm) return `Rot ${lm[2]} · ${Number(lm[1])}`;
    const s = n.toLowerCase();
    if (s === 'skeleton') return 'Skeleton';
    if (s === 'skeletonburned') return 'Skeleton (burned)';
    if (s === 'skeletonmuscle') return 'Skeleton (muscle)';
    return n.replace(/^[mf]_/i, '').replace(/body/i, '').replace(/_/g, ' ').replace(/([a-z])(\d)/i, '$1 $2').replace(/\s+/g, ' ').trim() || n;
  };
  const zChip = (on: boolean) => ({ minWidth: 34, borderRadius: 6, padding: '7px 8px', background: on ? '#4f7a3a' : '#14141a', color: on ? '#fff' : '#9cc77a', border: '1px solid ' + (on ? '#5a8a42' : '#3a5a2a') }) as const;
  const zombieSelected = zombieSkins.includes(skin);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, overflowY: 'auto' }}>
      <div style={{ padding: 12, borderBottom: '1px solid var(--line)' }}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <button className="secondary" onClick={onOpenSaved} style={{ flex: 1, minWidth: 0, padding: '8px 12px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
            <span style={{ fontSize: 14 }}>★</span> Saved{savedCount ? ` (${savedCount})` : ''}
          </button>
          <button className="secondary" onClick={onNew} title="Start a fresh, clean character" style={{ flex: 1, minWidth: 0, padding: '8px 12px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
            <span style={{ fontSize: 15, lineHeight: 1 }}>＋</span> New character
          </button>
        </div>
        {!isMobile && <button className="secondary" onClick={onImport} style={{ width: '100%', padding: '8px 12px', marginBottom: 12, background: 'var(--accent)', color: '#fff' }}>Import from a PZ save file…</button>}
        <label style={{ color: 'var(--muted)', fontSize: 12 }}>Gender</label>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '4px 0 12px' }}>
          <div style={{ display: 'flex', border: '1px solid var(--line)', borderRadius: 6, overflow: 'hidden' }}>
            {(['male', 'female'] as const).map((g) => (
              <button key={g} className="secondary" onClick={() => setGender(g)} style={seg(gender === g)}>{g}</button>
            ))}
          </div>
        </div>
        {bodyOptions.length > 1 && (
          <>
            <label style={{ color: 'var(--muted)', fontSize: 12 }}>Body</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '4px 0 6px' }} title="A body mod is loaded - pick which body model to use">
              {bodyOptions.map((b) => (
                <button key={b.id} className="secondary" title={b.label} onClick={() => onBody(b.id)} style={{ ...chip(bodySel === b.id), minWidth: 0, maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.label}</button>
              ))}
            </div>
            {uvVerdict && (
              uvVerdict.compatible ? (
                <div title={`UV overlap with vanilla: ${Math.round(uvVerdict.score * 100)}%`} style={{ fontSize: 11, color: '#6ea06e', margin: '0 0 12px' }}>
                  Vanilla-compatible UVs: standard clothing and skins fit this body.
                </div>
              ) : (
                <div title={`UV overlap with vanilla: ${Math.round(uvVerdict.score * 100)}%`} style={{ fontSize: 11, color: '#c9a24b', margin: '0 0 12px', lineHeight: 1.35 }}>
                  Custom UV layout: painted-on clothing and the stock skin textures may not line up. Use this body mod&apos;s own skin textures, and prefer clothing made for it.
                </div>
              )
            )}
          </>
        )}
        {textureOptions.length > 1 && (
          <>
            <label style={{ color: 'var(--muted)', fontSize: 12 }}>Skin texture</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '4px 0 12px' }} title="A skin/texture mod is loaded - pick which body textures to paint">
              {textureOptions.map((t) => (
                <button key={t.id} className="secondary" title={t.label} onClick={() => onTexture(t.id)} style={{ ...chip(textureSel === t.id), minWidth: 0, maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.label}</button>
              ))}
            </div>
          </>
        )}
        <label style={{ color: 'var(--muted)', fontSize: 12 }}>Skin</label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
          {tones.map((t) => (
            <button key={t} className="secondary" title={t} onClick={() => onSkin(t)} style={chip(skin === t)}>{toneLabel(t)}</button>
          ))}
        </div>
        {zombieSkins.length > 0 && (
          <>
            <label style={{ color: '#9cc77a', fontSize: 12, display: 'block', marginTop: 12 }}>Zombie skin</label>
            {zombieSkins.length <= ZOMBIE_BUTTONS_MAX ? (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                {zombieSkins.map((z) => (
                  <button key={z} className="secondary" title={z} onClick={() => onSkin(z)} style={zChip(skin === z)}>{zombieLabel(z)}</button>
                ))}
              </div>
            ) : (
              <button className="secondary" onClick={() => setZModal(true)} style={{ ...zChip(zombieSelected), width: '100%', marginTop: 4, padding: '8px 12px' }}>
                Browse zombie skins ({zombieSkins.length}){zombieSelected ? `: ${zombieLabel(skin)}` : ''}
              </button>
            )}
          </>
        )}
      </div>
      {zModal && (
        <div onClick={() => setZModal(false)} style={{ position: 'fixed', inset: 0, background: '#000d', display: 'grid', placeItems: 'center', zIndex: 620, padding: 20 }}>
          <div onClick={(e) => e.stopPropagation()} className="card" style={{ maxWidth: 560, width: '100%', maxHeight: '82vh', overflow: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <b style={{ fontSize: 16, color: '#9cc77a' }}>Zombie skins <span style={{ color: 'var(--muted)', fontWeight: 400, fontSize: 12 }}>({zombieSkins.length})</span></b>
              <button className="secondary" onClick={() => setZModal(false)} aria-label="Close" style={{ width: 30, height: 30, padding: 0, display: 'grid', placeItems: 'center', flexShrink: 0 }}>✕</button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(94px, 1fr))', gap: 8 }}>
              {zombieSkins.map((z) => (
                <button key={z} className="secondary" title={z} onClick={() => { onSkin(z); setZModal(false); }}
                  style={{ padding: 0, borderRadius: 8, overflow: 'hidden', border: `2px solid ${skin === z ? '#5a8a42' : 'var(--line)'}`, display: 'flex', flexDirection: 'column', cursor: 'pointer', background: '#0e0e12' }}>
                  <div style={{ aspectRatio: '1', width: '100%', background: '#0e0e12' }}><Thumb depKey={`skin:${z}`} getUrl={() => skinThumbUrl(z)} /></div>
                  <span style={{ fontSize: 10.5, padding: '4px 3px', color: skin === z ? '#9cc77a' : 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{zombieLabel(z)}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      {/* The hair/beard grid keeps a usable floor even when the pickers above stack up (body, texture,
          zombie skin). The wrapper's min-height is a reliable definite box (so the whole panel scrolls
          rather than squeezing the grid), and minRows floors the scroll area to 2 actual card rows at
          the current thumbnail size. */}
      <div style={{ flex: 1, minHeight: isMobile ? 240 : 340 }}>
        <AssetGrid<HairItem>
          key={kind}
          minRows={2}
          items={items}
          facetLabel="letters"
          active={(it) => it.name === selected}
          onPick={(it) => onPickPart(kind, it)}
          favActive={(it) => it.name !== 'None' && favs.has(favKey(kind, it.name))}
          onToggleFav={(it) => { if (it.name !== 'None') onToggleFav(kind, it.name); }}
          extraControls={(
            <>
              <div style={{ display: 'flex', border: '1px solid var(--line)', borderRadius: 6, overflow: 'hidden' }} title="hair or beard">
                <button className="secondary" onClick={() => setKind('hair')} style={seg(kind === 'hair')}>hair</button>
                <button className="secondary" onClick={() => setKind('beard')} style={seg(kind === 'beard')}>beard</button>
              </div>
              <ColorPicker value={color} onChange={(hex) => onRecolour(kind, hex)} title="colour"
                match={kind === 'beard' ? { on: matchBeard, onToggle: onToggleMatchBeard, label: 'Match hair colour' } : undefined} />
            </>
          )}
          renderThumb={(it) => it.name === 'None'
            ? <span style={{ color: 'var(--muted)', fontSize: 13 }}>None</span>
            : <Thumb depKey={`hair:${kind}:${it.name}:${gender}`} getUrl={() => thumbs.hair(it, kind, gender)} />} />
      </div>
    </div>
  );
}

// Modal: gallery of saved characters, each with a preview snapshot; save the current one, load or delete.
function PresetsModal({ presets, onClose, onSave, onLoad, onDelete, onDuplicate }: {
  presets: Record<string, CharPreset>;
  onClose: () => void;
  onSave: (name: string) => Promise<void>;
  onLoad: (preset: CharPreset) => void;
  onDelete: (name: string) => void;
  onDuplicate: (preset: CharPreset) => void;
}) {
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const saved = Object.values(presets).sort((a, b) => a.name.localeCompare(b.name));
  const doSave = async () => { const n = name.trim(); if (!n || saving) return; setSaving(true); try { await onSave(n); setName(''); } finally { setSaving(false); } };
  const input = { background: '#14141a', color: 'var(--text)', border: '1px solid var(--line)', borderRadius: 6, padding: '8px 10px', fontSize: 13 } as const;
  return (
    <div style={{ position: 'fixed', inset: 0, background: '#000000aa', zIndex: 400, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 640, maxWidth: '92vw', maxHeight: '84vh', background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 10, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--line)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontWeight: 600 }}>Saved characters{saved.length ? ` (${saved.length})` : ''}</span>
          <span role="button" onClick={onClose} title="close" style={{ cursor: 'pointer', color: 'var(--muted)' }}>✕</span>
        </div>
        <div style={{ padding: '12px 14px', display: 'flex', gap: 8, borderBottom: '1px solid var(--line)' }}>
          <input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') doSave(); }} placeholder="Name the current character…" style={{ ...input, flex: 1 }} />
          <button disabled={!name.trim() || saving} onClick={doSave} style={{ padding: '8px 16px' }}>{saving ? 'Saving…' : 'Save current'}</button>
        </div>
        <div style={{ padding: 14, overflow: 'auto' }}>
          {!saved.length
            ? <div style={{ color: 'var(--muted)', fontSize: 13, textAlign: 'center', padding: '44px 12px', lineHeight: 1.6 }}>No saved characters yet.<br />Dress a survivor, name it above and hit <b>Save current</b>. A preview snapshot is stored with each.</div>
            : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(132px, 1fr))', gap: 12 }}>
                {saved.map((p) => (
                  <div key={p.name} className="preset-card">
                    <button className="preset-thumb" onClick={() => onLoad(p)} title={`Load ${p.name}`}>
                      {p.thumb ? <img src={p.thumb} alt="" /> : <span className="preset-noimg">◈</span>}
                      <span className="preset-badge">{p.gender === 'female' ? 'F' : 'M'}</span>
                      <span className="preset-load">Load</span>
                    </button>
                    <div className="preset-foot">
                      <span className="preset-name" title={p.name}>{p.name}</span>
                      <button className="preset-del" title="duplicate" onClick={() => onDuplicate(p)} style={{ color: 'var(--muted)' }}>⧉</button>
                      <button className="preset-del" title="delete" onClick={() => onDelete(p.name)}>✕</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
        </div>
      </div>
    </div>
  );
}

// Modal: pick the Zomboid saves folder, list saves + their character, import a look.
const relTime = (ms: number) => {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 90) return 'just now';
  const m = s / 60; if (m < 60) return `${Math.round(m)} min ago`;
  const h = m / 60; if (h < 24) return `${Math.round(h)} hr ago`;
  const d = h / 24; if (d < 30) return `${Math.round(d)} day${Math.round(d) === 1 ? '' : 's'} ago`;
  const mo = d / 30; if (mo < 12) return `${Math.round(mo)} month${Math.round(mo) === 1 ? '' : 's'} ago`;
  return `${Math.round(mo / 12)} yr ago`;
};

function ImportModal({ onClose, onImport }: { onClose: () => void; onImport: (p: ParsedChar) => Promise<void> }) {
  const [saves, setSaves] = useState<SaveEntry[] | null>(null);
  const [busy, setBusy] = useState('');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<'recent' | 'name' | 'save'>('recent');
  const [needReconnect, setNeedReconnect] = useState<FileSystemDirectoryHandle | null>(null);
  const scan = async (dir: FileSystemDirectoryHandle) => {
    setBusy('Scanning saves…');
    try { const s = await discoverSaves(dir); setSaves(s); setBusy(s.length ? '' : 'No saves with a character were found in that folder.'); }
    catch (e) { setBusy('error: ' + (e as Error).message); }
  };
  // remember the Zomboid folder for the session: auto-scan if we still have permission, else offer a one-click reconnect
  useEffect(() => {
    (async () => {
      const h = await loadDir(SAVES_KEY);
      if (!h) return;
      if (await hasPermission(h)) scan(h); else setNeedReconnect(h);
    })();
  }, []);
  const reconnect = async () => {
    if (!needReconnect) return;
    if (await requestPermission(needReconnect)) { setNeedReconnect(null); scan(needReconnect); }
    else setBusy('Permission denied.');
  };
  const pick = async () => {
    setBusy('Opening folder…');
    try {
      const dir = await pickDirectory('pz-saves');
      if (!dir) { setBusy(''); return; } // cancelled
      await saveDir(SAVES_KEY, dir); setNeedReconnect(null);
      await scan(dir);
    } catch (e) { setBusy('error: ' + (e as Error).message); }
  };
  const doImport = async (entry: SaveEntry) => {
    setBusy('Reading ' + entry.name + '…');
    try { const parsed = await importCharacter(entry); await onImport(parsed); onClose(); }
    catch (e) { setBusy('error reading save: ' + (e as Error).message); }
  };
  const shown = useMemo(() => {
    if (!saves) return [];
    const f = q.trim().toLowerCase();
    const rows = f ? saves.filter((s) => (s.name + ' ' + s.save + ' ' + s.mode).toLowerCase().includes(f)) : saves.slice();
    rows.sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name) : sort === 'save' ? (a.mode.localeCompare(b.mode) || b.save.localeCompare(a.save)) : b.lastModified - a.lastModified);
    return rows;
  }, [saves, q, sort]);
  const row = { display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px', margin: '4px 0', borderRadius: 6 } as const;
  const input = { background: '#14141a', color: 'var(--text)', border: '1px solid var(--line)', borderRadius: 6, padding: '6px 8px', fontSize: 12.5 } as const;
  return (
    <div style={{ position: 'fixed', inset: 0, background: '#000000aa', zIndex: 400, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 540, maxWidth: '92vw', maxHeight: '82vh', background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 10, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--line)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontWeight: 600 }}>Import character look from a save</span>
          <span role="button" onClick={onClose} title="close" style={{ cursor: 'pointer', color: 'var(--muted)' }}>✕</span>
        </div>
        <div style={{ padding: 14, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {needReconnect && !saves && (
              <button onClick={reconnect} style={{ padding: '8px 14px' }}>Reconnect “{needReconnect.name}”</button>
            )}
            <button className="secondary" onClick={pick} style={{ padding: '8px 14px', background: saves || needReconnect ? 'var(--panel)' : 'var(--accent)', color: saves || needReconnect ? 'var(--text)' : '#fff' }}>{saves || needReconnect ? 'Choose another folder' : 'Choose your Zomboid folder…'}</button>
            {saves && saves.length > 0 && (
              <>
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${saves.length} saves…`} style={{ ...input, flex: '1 1 140px', minWidth: 120 }} />
                <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} style={input} title="sort">
                  <option value="recent">Last played</option>
                  <option value="name">Character name</option>
                  <option value="save">Save</option>
                </select>
              </>
            )}
          </div>
          {!saves && <div style={{ color: 'var(--muted)', fontSize: 11, margin: '8px 0 4px' }}>Point at your Zomboid folder (usually in Documents) or its Saves folder. Read locally in your browser, and nothing is uploaded.</div>}
          {busy && <div style={{ color: 'var(--muted)', fontSize: 13, padding: '6px 2px' }}>{busy}</div>}
          <div style={{ overflow: 'auto', marginTop: 8, minHeight: 0 }}>
            {shown.map((s, i) => (
              <button key={i} className="secondary" onClick={() => doImport(s)} style={row}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                  <span style={{ fontSize: 13, flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.name}</span>
                  <span style={{ fontSize: 11, color: 'var(--muted)', flexShrink: 0 }}>{relTime(s.lastModified)}</span>
                </div>
                <div style={{ fontSize: 11, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.mode} · {s.save} · v{s.worldVersion}</div>
              </button>
            ))}
            {saves && saves.length > 0 && !shown.length && <div style={{ color: 'var(--muted)', fontSize: 13, padding: 12, textAlign: 'center' }}>No saves match “{q}”.</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
