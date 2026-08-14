import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { listClips, listClothing, listHeldItems, listHair, clothingGroup, CLOTHING_GROUP_ORDER, HELD_GROUP_ORDER, SKIN_TONES, attachmentProviders, listZombieSkins, listBodySources, listBodyTextureSources, clothingBodyFit } from '@shared/character-core.js';
import { SLOTS, bodyAttachOptions, slotsFromWorn } from '@shared/attachments.js';
import { CharacterEngine, type Ctx, type AttachOption, type TileBrushPart, type PropSave, type TileSave } from './render/character-engine';
import { Dopesheet, keyId, parseKeySel } from './Dopesheet';
import { usePoseEditor, type PoseData } from './usePoseEditor';
import { PoseEditorPanel } from './PoseEditorPanel';

type AttachSlot = { slot: string; options: AttachOption[] };
import { ThumbnailProvider } from './render/thumbnail-provider';
import { ClipPreview, type PreviewEdit } from './render/clip-preview';
import { getSettings, subscribeSettings, matchBind, hexToInt, type Settings } from './settings';
import { FloorLibrary } from './render/floor';
import { TileLibrary, type TileCategory, type TileSet, type TilePiece } from './render/tiles-lib';
import { parseMod, resolveIconAssets } from '@shared/icon-core.js';
import { AssetGrid, type GridItem } from './AssetGrid';
import { Thumb } from './Thumb';
import { exportPng, exportGif, exportVideo, download, codecSupported, type BgConfig, type Content, type VideoCodec, type VideoQuality } from './render/export-media';
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
type ExportOpts = { pngRes: number; gifRes: number; gifColors: number; gifFps: number; mp4Res: number; mp4Fps: number; mp4Codec: VideoCodec; mp4Quality: VideoQuality };
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
  // placed 3D props (build tab): serialised by item name + transform + sticky-attach + weapon parts, re-resolved on load.
  props?: PropSave[];
  // placed 2D tiles (build tab): serialised by tile name + cell + slot, textures re-resolved on load.
  tiles?: TileSave[];
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
function BoxIcon({ size = 18 }: { size?: number }) { // Props (3D objects) overlay button
  return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" /><path d="m3.3 7 8.7 5 8.7-5" /><path d="M12 22V12" /></svg>;
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
  const [resetConfirm, setResetConfirm] = useState<{ name: string } | null>(null); // "save edited animation before resetting to idle?" prompt
  const [loadConfirm, setLoadConfirm] = useState<{ clip: Clip; name: string } | null>(null); // "save edits before loading a different animation?" prompt
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
  const [exp, setExp] = useState<ExportOpts>({ pngRes: 1080, gifRes: 512, gifColors: 256, gifFps: 24, mp4Res: 1080, mp4Fps: 30, mp4Codec: 'auto', mp4Quality: 'high' }); // advanced per-format export knobs
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
  const quickSaveRef = useRef<() => void>(() => {}); // Ctrl+S target (kept fresh each render)
  const markDirtyRef = useRef<() => void>(() => {}); // flags the pose dirty from the (set-once) onBoneEdit callback
  const poseDirtyRef = useRef(false);                // latest unsaved-edits flag for the beforeunload guard
  const settingsRef = useRef<Settings>(getSettings()); // current keybinds for the keydown handler (kept fresh via subscription)
  const [devMode, setDevMode] = useState(getSettings().devMode); // reactive: reveals developer/debug buttons
  useEffect(() => subscribeSettings((st) => { settingsRef.current = st; setDevMode(st.devMode); }), []);
  // Warn before the tab/window closes or reloads with unsaved pose edits (browser dialog; Electron's renderer
  // honours the same beforeunload cancel, so the desktop window won't quietly discard edits either).
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => { if (poseDirtyRef.current && engineRef.current?.hasCurrentEdits()) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);
  const pendingPresetRef = useRef<CharPreset | null>(bootChar.current); // restore the autosaved look on first load
  const applyPresetLookRef = useRef<((p: CharPreset) => Promise<void>) | null>(null);
  const initedGenderRef = useRef<string | null>(null); // gender whose body has had its look applied (avoids a re-run wiping it)
  const bootedRef = useRef(false); // first body load + restore done -> safe to start auto-saving
  const scrubRef = useRef<HTMLInputElement>(null);
  const scrubbingRef = useRef(false);
  const playheadRef = useRef<HTMLDivElement>(null); // dopesheet playhead, positioned by onFrame without a re-render
  const trackGeomRef = useRef({ pad: 6, usable: 1 }); // dopesheet tick->px mapping (inset so edge diamonds don't overflow), read by onFrame + the Dopesheet

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
  const [selectedTile, setSelectedTile] = useState<string | null>(null); // the exact piece placed (the brush)
  const [selectedSet, setSelectedSet] = useState<string | null>(null);    // the material set whose pieces are shown
  // build modes: erase (touch has no right-click) and rectangle-fill (touch has no shift) as explicit
  // toggles; desktop keeps right-click-erase and shift-drag-rectangle too
  const [buildMode, setBuildModeState] = useState<'place' | 'erase'>('place');
  const [rectMode, setRectMode] = useState(false);
  const [eraseDepth, setEraseDepth] = useState(0); // phone erase-depth stepper (0 = top layer)
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const applyBuildMode = (m: 'place' | 'erase') => { setBuildModeState(m); if (m === 'erase') { setEraseDepth(0); engineRef.current?.setEraseLayer(0); } engineRef.current?.setBuildMode(m); };
  const applyRectMode = (on: boolean) => { setRectMode(on); engineRef.current?.setRectMode(on); };
  const applyEraseDepth = (d: number) => { const v = Math.max(0, d); setEraseDepth(v); engineRef.current?.setEraseLayer(v); };
  useEffect(() => {
    if (tab !== 'build' || tileReady) return;
    let ok = true;
    tileLib.ensure().then(() => { if (ok) setTileReady(true); }).catch(() => { if (ok) setTileReady('error'); });
    return () => { ok = false; };
  }, [tab, tileLib, tileReady]);
  // Browse by material set (walls collapse to one card per colour/wallpaper; other tiles are single-piece
  // sets). Picking a set selects its default piece; multi-piece sets reveal a piece picker.
  const tileSets = useMemo(() => (tileReady === true ? tileLib.sets(tileCat) : []), [tileReady, tileLib, tileCat]);
  const tileItems = useMemo(() => tileSets.map((s) => ({ key: s.id, label: s.label, facet: s.sheet, isMod: false, name: s.rep.name, setId: s.id, defaultPiece: s.defaultPiece, pieceCount: s.pieces.length, thumbTiles: (s.pieces.find((p) => p.tile.name === s.defaultPiece) ?? s.pieces[0]).tiles })), [tileSets]);
  const selectedSetObj = useMemo(() => tileSets.find((s) => s.id === selectedSet) ?? null, [tileSets, selectedSet]);
  const selPieceTiles = useMemo(() => selectedSetObj?.pieces.find((p) => p.tile.name === selectedTile)?.tiles ?? null, [selectedSetObj, selectedTile]);
  // 3D props: parse the item catalog for records that carry a 3D world/static model.
  type PropRec = { item: string; variant: string; mesh: string | null; hasModelBlock: boolean; displayCategory?: string; textureName: string | null; scale: number };
  const [buildTab, setBuildTab] = useState<'2d' | '3d'>('2d'); // Build sub-tab: 2D tile builder vs 3D-props browser
  const [inspectorOpen, setInspectorOpen] = useState(false);   // selected-prop controls popover (anchored to the Props button)
  const [propMore, setPropMore] = useState(false);             // mobile prop sheet: reveal texture + attachments
  const propRecords = useMemo<PropRec[]>(() => { try { return (parseMod(index as never).records as PropRec[]).filter((r) => r.variant === 'base' && !!r.mesh && r.hasModelBlock); } catch { return []; } }, [index]);
  // Browser = every held item / weapon (their 3D model, categorised by held group) UNION the world-object props,
  // deduped by name. Held come first so weapons keep their friendly labels + weapon categories.
  const propItems = useMemo(() => {
    const seen = new Set<string>();
    const out: { key: string; label: string; facet: string; isMod: boolean; search?: string; rec: PropRec }[] = [];
    for (const h of held) {
      if (!h.mesh) continue; const k = h.name.toLowerCase(); if (seen.has(k)) continue; seen.add(k);
      out.push({ key: h.name, label: h.label, facet: h.facet || 'Held', isMod: !!h.isMod, search: h.search, rec: { item: h.name, variant: 'base', mesh: h.mesh, textureName: h.texture ?? null, scale: h.scale ?? 1, hasModelBlock: true, displayCategory: h.facet } });
    }
    for (const r of propRecords) { const k = r.item.toLowerCase(); if (seen.has(k)) continue; seen.add(k); out.push({ key: r.item, label: r.item, facet: r.displayCategory || 'Other', isMod: false, rec: r }); }
    return out;
  }, [held, propRecords]);
  const placeProp = async (rec: PropRec) => {
    try {
      const a = await resolveIconAssets(ctx, rec) as { meshGlb: Uint8Array | null; texture: Uint8Array | null; scale: number; subMesh: string | null };
      if (a.meshGlb) { await engineRef.current?.beginPropPlacement(a.meshGlb, a.texture, a.scale, rec.item, a.subMesh); if (isMobile) setDrawerOpen(false); } // prop rides the cursor; click to drop
    } catch (e) { console.warn('prop place failed', e); }
  };
  // Rehydrate placed props from a preset: re-resolve each by item name, restore transform + sticky + weapon parts.
  const loadProps = async (saves: PropSave[] | undefined) => {
    const eng = engineRef.current; if (!eng) return;
    eng.clearProps();
    if (!saves?.length) return;
    for (const s of saves) {
      try {
        const it = propItems.find((p) => p.key === s.item); if (!it) continue; // item no longer in the loaded mod set
        const a = await resolveIconAssets(ctx, it.rec) as { meshGlb: Uint8Array | null; texture: Uint8Array | null; scale: number; subMesh: string | null };
        if (!a.meshGlb) continue;
        const slots = heldSlots.get(s.item);
        const attachments = s.attachments.map((sa) => { const opt = slots?.find((x) => x.slot === sa.slot)?.options.find((o) => o.partName === sa.partName); return opt ? { slot: sa.slot, option: opt } : null; }).filter(Boolean) as { slot: string; option: AttachOption }[];
        await eng.addSavedProp({ glb: a.meshGlb, texture: a.texture, subMesh: a.subMesh, baseScale: a.scale, save: s, attachments });
      } catch (e) { console.warn('prop load failed', s.item, e); }
    }
    eng.relinkPropAttachments();
  };
  // Rehydrate placed 2D tiles from a preset: re-resolve each tile's texture by name and rebuild it at its cell.
  const loadTiles = async (saves: TileSave[] | undefined) => {
    const eng = engineRef.current; if (!eng) return;
    eng.clearTiles();
    if (!saves?.length) return;
    for (const t of saves) {
      try {
        if (t.slot === 'floor' || t.slot === 'rug') {
          const tex = await tileLib.flatTexture(t.name);
          if (tex) eng.addSavedTile(t.gx, t.gy, { tex, kind: t.slot === 'rug' ? 'rug' : 'floor', name: t.name });
        } else {
          const s = await tileLib.spriteTexture(t.name);
          if (s) eng.addSavedTile(t.gx, t.gy, { tex: s.tex, kind: 'object', objectSlot: t.slot, name: t.name, fullW: s.full.w, fullH: s.full.h });
        }
      } catch (e) { console.warn('tile load failed', t.name, e); }
    }
  };
  type PropTexXf = { flipU: boolean; flipV: boolean; rot: number };
  const [selectedProp, setSelectedProp] = useState<{ name: string; count: number; texXf: PropTexXf; sticky: boolean; align: boolean; attached: string | null; attachments: { slot: string; partName: string }[] } | null>(null);
  const [marqueeRect, setMarqueeRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null); // shift-drag selection box, drawn over the canvas
  const [twistInfo, setTwistInfo] = useState<{ x: number; y: number; axis: 'view' | 'x' | 'y' | 'z'; dir: { x: number; y: number }; tilt: number } | null>(null); // scroll-rotate axis gizmo over the dragged bone
  const [editState, setEditState] = useState<{ active: boolean; clip: string | null; editable: boolean; bones: string[] }>({ active: false, clip: null, editable: false, bones: [] }); // animation pose editor
  const [editOpen, setEditOpen] = useState(false); // editor panel popover visibility (toggled from the top-right button)
  const [dressState, setDressState] = useState<{ worn: boolean; shown: boolean }>({ worn: false, shown: false }); // skirt/dress bones + mesh: worn = a garment forces it on
  const bottomBarRef = useRef<HTMLDivElement>(null); // dopesheet + transport bar, so the editor panel can sit above it
  const [bottomBarH, setBottomBarH] = useState(0);
  useEffect(() => { const el = bottomBarRef.current; if (!el) { setBottomBarH(0); return; } const ro = new ResizeObserver(() => setBottomBarH(el.offsetHeight)); ro.observe(el); setBottomBarH(el.offsetHeight); return () => ro.disconnect(); }, [editState.active, isMobile]);
  const [keySel, setKeySel] = useState<Set<string>>(() => new Set()); // selected keyframes as "bone@tick" ids (shared with the Dopesheet + the keydown handler)
  const keySelRef = useRef(keySel); keySelRef.current = keySel; // for the global keydown handler
  const [selectedBones, setSelectedBones] = useState<string[]>([]);
  const [boneTick, setBoneTick] = useState(0); // bump after setBoneEdit so the panel re-reads engine values
  const [boneSearch, setBoneSearch] = useState('');
  const [saveAsName, setSaveAsName] = useState('');
  const capturePreview = (): string | undefined => { try { return engineRef.current?.snapshotFront(260, 340, '#1b1d24'); } catch { return undefined; } };
  const pose = usePoseEditor({ engineRef, editState, saveAsName, clips, capture: capturePreview, bump: () => setBoneTick((t) => t + 1), toast: setNowPlaying });
  quickSaveRef.current = pose.requestSave;
  markDirtyRef.current = pose.markDirty; // onBoneEdit (set once) flags the pose dirty through this
  poseDirtyRef.current = pose.dirty;      // read by the beforeunload guard (registered once)
  const [placeHint, setPlaceHint] = useState<'character' | 'prop' | 'floor' | null>(null); // live target while a prop rides the cursor
  const [placingProp, setPlacingProp] = useState<string | null>(null); // the prop item riding the cursor, so its grid thumbnail stays highlighted until placed
  const [gizmoMode, setGizmoModeState] = useState<'translate' | 'rotate' | 'scale'>('translate');
  const applyGizmoMode = (m: 'translate' | 'rotate' | 'scale') => { setGizmoModeState(m); engineRef.current?.setGizmoMode(m); };
  const [showGizmo, setShowGizmoFlag] = useState(false); // Blender-style: handles hidden by default, G/R/S transform
  const toggleGizmo = (on: boolean) => { setShowGizmoFlag(on); engineRef.current?.setShowGizmo(on); };
  const [camLock, setCamLockFlag] = useState(false); // mobile: two-finger gestures move the camera even with a prop selected
  const toggleCamLock = (on: boolean) => { setCamLockFlag(on); engineRef.current?.setCameraLock(on); };
  const [selectMode, setSelectModeFlag] = useState(false); // mobile: tap toggles a prop / drag draws a marquee
  const toggleSelectMode = (on: boolean) => { setSelectModeFlag(on); engineRef.current?.setSelectMode(on); };
  const [stickyDefault, setStickyDefaultFlag] = useState(true); // new props start sticky-armed
  const [alignDefault, setAlignDefaultFlag] = useState(true);   // new props align to the surface (+ live preview)
  const toggleStickyDefault = (on: boolean) => { setStickyDefaultFlag(on); engineRef.current?.setStickyDefault(on); };
  const toggleAlignDefault = (on: boolean) => { setAlignDefaultFlag(on); engineRef.current?.setAlignDefault(on); };
  const [modalLabel, setModalLabel] = useState<string | null>(null); // active modal-transform readout ("Move X")
  // entering the 3D-props browser sub-tab: free-orbit camera for placing (the tile brush is dropped by the brush effect).
  // prop clicks stay enabled on every tab (engine setPropMode(true) at boot); they just yield to an active tile brush.
  useEffect(() => {
    const eng = engineRef.current; if (!eng) return;
    if (tab === 'build' && buildTab === '3d') eng.applyCameraPreset('orbit');
  }, [tab, buildTab]);
  // exports render the live scene, so deselect (drop the selection rim + close the inspector) before an export
  useEffect(() => { if (tab === 'export') { engineRef.current?.selectProp(null); setInspectorOpen(false); } }, [tab]);
  // per-prop UV fix for the selected prop (the rare mesh whose texture maps wrong, e.g. Battery)
  const applyPropTexXf = (xf: PropTexXf) => { setSelectedProp((s) => (s ? { ...s, texXf: xf } : s)); engineRef.current?.setSelectedPropTexXf(xf); };
  // sticky controls (the engine echoes new state back through onPropSelect, which updates selectedProp)
  const setPropSticky = (on: boolean) => engineRef.current?.setSelectedPropSticky(on);
  const setPropAlign = (on: boolean) => engineRef.current?.setSelectedPropAlign(on);
  const detachProp = () => engineRef.current?.detachSelectedProp();
  const setPropAttach = (slot: string, option: AttachOption | null) => { void engineRef.current?.setPropAttachment(slot, option); };
  // pick a set: select its default piece; on mobile collapse the drawer only when there's no piece to choose
  const pickSet = (item: { setId: string; defaultPiece: string; pieceCount: number }) => {
    if (item.setId === selectedSet) { setSelectedSet(null); setSelectedTile(null); return; }
    setSelectedSet(item.setId); setSelectedTile(item.defaultPiece);
    if (isMobile) setDrawerOpen(false); // the piece picker rides on the compact bar, so free the canvas
  };
  const pickPiece = (name: string) => { setSelectedTile(name); }; // stay put; the picker is always in reach
  // R / Shift+R step through the open set's pieces; number keys 1-9 jump straight to one. A ref keeps the
  // key handler (registered once) reading the current set/selection without re-binding on every change.
  const kb = useRef<{ buildMode: 'place' | 'erase'; set: TileSet | null; tile: string | null; hasProp: boolean; tilesActive: boolean; editing: boolean; anim: boolean }>({ buildMode, set: selectedSetObj, tile: selectedTile, hasProp: !!selectedProp, tilesActive: tab === 'build' && buildTab === '2d', editing: editState.active, anim: tab === 'animate' });
  kb.current = { buildMode, set: selectedSetObj, tile: selectedTile, hasProp: !!selectedProp, tilesActive: tab === 'build' && buildTab === '2d', editing: editState.active, anim: tab === 'animate' };
  const cyclePiece = (dir: number) => {
    const s = kb.current.set; if (!s || s.pieces.length < 2) return;
    const i = s.pieces.findIndex((p) => p.tile.name === kb.current.tile); const n = s.pieces.length;
    setSelectedTile(s.pieces[(((i < 0 ? 0 : i) + dir) % n + n) % n].tile.name);
  };
  const selectPieceByNumber = (idx: number) => { const s = kb.current.set; if (s && idx >= 0 && idx < s.pieces.length) setSelectedTile(s.pieces[idx].tile.name); };
  // The placement brush for the selected tile: floors/rugs become flat de-sheared tiles; walls/furniture
  // become camera-facing standing sprites. Leaving the Build tab clears it. Snap to the PZ-iso camera
  // so what you place reads correctly.
  const selectedTileInfo = selectedTile ? tileLib.get(selectedTile) : undefined;
  useEffect(() => {
    const eng = engineRef.current; if (!eng) return;
    const info = selectedTile ? tileLib.get(selectedTile) : undefined;
    if (tab !== 'build' || buildTab !== '2d' || !selectedTile || !info) { eng.setBuildBrush(null); return; }
    let ok = true;
    if (eng.camMode !== 'iso') eng.applyCameraPreset('iso');
    (async () => {
      if (info.category === 'floor' || info.category === 'overlay') {
        const tex = await tileLib.flatTexture(selectedTile);
        if (ok && tex) eng.setBuildBrush({ tex, kind: info.category === 'overlay' ? 'rug' : 'floor', name: selectedTile });
      } else {
        // wall or furniture (standing sprite). A multi-tile furniture facing carries sibling sprites as
        // `parts` (offset cells) so the whole couch/bed places together and previews together.
        const piece = selectedSetObj?.pieces.find((p) => p.tile.name === selectedTile);
        const s = await tileLib.spriteTexture(selectedTile);
        if (!ok || !s) return;
        const objectSlot = info.category === 'wall' ? 'wall' as const : 'furniture' as const;
        const parts: TileBrushPart[] = [];
        for (const pt of (piece ? piece.tiles.slice(1) : [])) {
          const ps = await tileLib.spriteTexture(pt.tile.name);
          if (ps) parts.push({ tex: ps.tex, fullW: ps.full.w, fullH: ps.full.h, dx: pt.dx, dy: pt.dy, name: pt.tile.name });
        }
        if (ok) eng.setBuildBrush({ tex: s.tex, kind: 'object', objectSlot, name: selectedTile, fullW: s.full.w, fullH: s.full.h, parts: parts.length ? parts : undefined });
      }
    })();
    return () => { ok = false; };
  }, [tab, buildTab, selectedTile, selectedSetObj, tileLib]);
  // Desktop keyboard shortcuts while on the Build tab: E toggles erase. In PLACE mode R / Shift+R step
  // through the open set's pieces and 1-9 jump to one; in ERASE mode R cycles which stacked item is
  // targeted. Ctrl+Z / Ctrl+Y (or Ctrl+Shift+Z) undo/redo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const eng = engineRef.current; if (!eng) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      const hasProp = kb.current.hasProp, tiles = kb.current.tilesActive, editing = kb.current.editing;
      const kbd = settingsRef.current.keys; // user-configurable binds
      // Clip transport (animate tab or pose editor): space play/pause, arrows step a frame, shift+arrows to the ends.
      if ((kb.current.anim || editing) && !eng.boneModalActive()) {
        if (matchBind(e, kbd.playPause)) { e.preventDefault(); setPlaying(eng.togglePlay()); return; }
        if (matchBind(e, kbd.clipStart)) { e.preventDefault(); eng.seekClipEdge(false); return; }
        if (matchBind(e, kbd.clipEnd)) { e.preventDefault(); eng.seekClipEdge(true); return; }
        if (matchBind(e, kbd.stepPrev)) { e.preventDefault(); eng.stepFrame(-1); return; }
        if (matchBind(e, kbd.stepNext)) { e.preventDefault(); eng.stepFrame(1); return; }
      }
      if (!hasProp && !tiles && !editing) return; // no build/edit context: leave the remaining keys alone
      // Deselect / cancel: clear a keyframe selection first, else drop a modal transform / placement.
      if (matchBind(e, kbd.deselect)) { if (eng.boneModalActive()) { e.preventDefault(); eng.cancelBoneModal(); return; } if (editing && keySelRef.current.size) { e.preventDefault(); setKeySel(new Set()); return; } eng.modalCancel(); eng.cancelPropPlacement(); return; }
      // Delete: selected keyframes, else the selected prop. Backspace stays an alias while Delete is the default bind.
      if (matchBind(e, kbd.delete) || (kbd.delete?.key === 'Delete' && e.key === 'Backspace' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey)) {
        if (editing && keySelRef.current.size) { e.preventDefault(); eng.deleteKeys(parseKeySel(keySelRef.current)); setKeySel(new Set()); setBoneTick((t) => t + 1); return; }
        if (hasProp) { e.preventDefault(); eng.deleteSelectedProp(); return; }
        return;
      }
      if (editing && matchBind(e, kbd.savePose)) { e.preventDefault(); quickSaveRef.current(); return; } // save the current pose
      if (hasProp && matchBind(e, kbd.duplicate)) { e.preventDefault(); eng.duplicateSelectedProp(); return; } // duplicate selected prop
      if (editing && matchBind(e, kbd.copyKeys) && keySelRef.current.size) { e.preventDefault(); eng.copyKeys(parseKeySel(keySelRef.current)); return; } // copy selected keyframes
      if (editing && matchBind(e, kbd.pasteKeys) && eng.keyClipboardSize()) { e.preventDefault(); const p = eng.pasteKeysAt(eng.currentTick()); setKeySel(new Set(p.map((m) => keyId(m.bone, m.tick)))); setBoneTick((t) => t + 1); return; } // paste at playhead
      if (matchBind(e, kbd.undo)) { e.preventDefault(); eng.undo(); return; }
      if (matchBind(e, kbd.redo) || (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'z')) { e.preventDefault(); eng.redo(); return; } // Ctrl+Shift+Z stays a redo alias
      if (e.ctrlKey || e.metaKey) return; // an unbound command combo: don't let it fall through to the single-key shortcuts below
      if (editing && e.key.toLowerCase() === 'r' && eng.isDraggingBone()) { e.preventDefault(); eng.cycleTwistAxis(); return; } // R while scroll-rotating a bone: cycle the twist axis
      if (editing) { // Blender-style modal transform of the selected pose node(s): G move, R rotate, X/Y/Z lock axis, Enter confirm
        if (eng.boneModalActive()) {
          if (e.key === 'Enter') { e.preventDefault(); eng.confirmBoneModal(); return; }
          const ax = e.key.toLowerCase();
          if (ax === 'x' || ax === 'y' || ax === 'z') { e.preventDefault(); eng.boneModalAxis(ax); return; }
        }
        const gk = e.key.toLowerCase();
        if (gk === 'g') { e.preventDefault(); eng.startBoneModal('move'); return; }
        if (gk === 'r' && !eng.isDraggingBone()) { e.preventDefault(); eng.startBoneModal('rotate'); return; }
      }
      if (hasProp) { // a selected prop (any tab): Blender-style G move, R rotate, S scale, X/Y/Z lock axis, Enter confirm
        if (e.key === 'Enter') { e.preventDefault(); eng.modalConfirm(); return; }
        const gk = e.key.toLowerCase();
        if (gk === 'g') { e.preventDefault(); eng.startModalTransform('move'); return; }
        if (gk === 'r') { e.preventDefault(); eng.startModalTransform('rotate'); return; }
        if (gk === 's') { e.preventDefault(); eng.startModalTransform('scale'); return; }
        if (gk === 'x' || gk === 'y' || gk === 'z') { e.preventDefault(); eng.modalSetAxis(gk); return; }
        return;
      }
      if (!tiles || e.altKey) return; // tile keybindings only while the 2D tile builder is active
      const mode = kb.current.buildMode;
      const k = e.key.toLowerCase();
      if (k === 'e') { e.preventDefault(); applyBuildMode(mode === 'erase' ? 'place' : 'erase'); }
      else if (k === 'r') {
        e.preventDefault();
        if (mode === 'erase') { eng.cycleEraseLayer(1); setEraseDepth(eng.eraseLayerInfo().index); }
        else cyclePiece(e.shiftKey ? -1 : 1);
      } else if (mode === 'place' && e.key >= '1' && e.key <= '9') { e.preventDefault(); selectPieceByNumber(Number(e.key) - 1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
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
    eng.onFrame = (t, dur) => { const frac = dur ? Math.min(t, dur) / dur : 0; const el = scrubRef.current; if (el && !scrubbingRef.current) el.value = String(frac * 1000); if (playheadRef.current) { const g = trackGeomRef.current, pf = engineRef.current?.playheadFrac() ?? frac; playheadRef.current.style.left = `${g.pad + pf * g.usable}px`; } };
    eng.onPlaying = setPlaying; // a one-shot clip finishing flips the play/pause button back to play
    eng.onCamMode = setCamMode; // keep the Scene-tab toggle in sync with auto-switches
    eng.onViewfinder = setViewfinder; // studio letterbox rect (CSS px)
    eng.onHistory = (u, r) => { setCanUndo(u); setCanRedo(r); }; // enable/disable undo+redo affordances
    eng.onPropSelect = (info) => { setSelectedProp(info); if (info) { if (isMobileRef.current) setDrawerOpen(false); else setInspectorOpen(true); setSceneOpen(false); setEquipOpen(false); } }; // desktop: open the detail popover. mobile: the bottom bar owns it, so just free the canvas
    eng.onMarquee = (r) => setMarqueeRect(r); // shift-drag box: draw it over the canvas
    eng.onTwist = (info) => setTwistInfo(info); // scroll-rotate: show the live angle + active axis over the bone
    eng.onEditState = (s) => { setEditState(s); setEditOpen(s.active); if (s.active) { setSaveAsName(s.clip ? s.clip + '_Edited' : ''); setSceneOpen(false); setEquipOpen(false); setInspectorOpen(false); } else { setSelectedBones([]); setBoneSearch(''); } };
    eng.onBoneSelect = setSelectedBones;
    eng.onDressState = setDressState; // skirt/dress toggle reflects worn-garment auto-show
    setDressState({ worn: eng.dressWornNow(), shown: eng.dressVisible() }); // seed from the already-loaded body
    eng.onBoneEdit = () => { setBoneTick((t) => t + 1); markDirtyRef.current(); }; // a gizmo drag changed a bone: refresh the panel readouts + flag unsaved
    eng.onPlacementHint = setPlaceHint; // live "will drop on: character/prop/floor" hint while placing
    eng.onPlacing = setPlacingProp; // highlight the placing item's thumbnail until it drops
    eng.onModalChange = setModalLabel; // Blender-style modal-transform status ("Move X")
    eng.setPropMode(true); // prop clicks enabled on every tab (the engine yields to an active tile brush)
    engineRef.current = eng;
    const applyEngineSettings = (st: Settings) => { eng.setCameraControls(st.camera); eng.setNodeStyle({ scale: st.nodes.scale, opacity: st.nodes.opacity, selectedOpacity: st.nodes.selectedOpacity, colors: Object.fromEntries(Object.entries(st.nodes.colors).map(([k, v]) => [k, hexToInt(v)])) }); };
    applyEngineSettings(getSettings());
    const unsubSettings = subscribeSettings(applyEngineSettings); // live camera-control + node-style updates from the settings modal
    const ro = new ResizeObserver(() => eng.resize());
    if (canvasRef.current?.parentElement) ro.observe(canvasRef.current.parentElement);
    return () => { unsubSettings(); ro.disconnect(); eng.dispose(); engineRef.current = null; };
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
          try { await eng.playClip(idleClip); setPlaying(true); setEditState({ active: false, clip: idleClip.name, editable: !!eng.canEditClip(), bones: [] }); } catch { /* non-fatal */ }
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
  const playClip = (c: Clip) => guard(async () => { const wasEditing = editState.active; const eng = engineRef.current!; await eng.playClip(c); setPlaying(true); setCurrentClipId(c.id); setEditState({ active: false, clip: c.name, editable: !!eng.canEditClip(), bones: [] }); if (wasEditing && eng.canEditClip()) { eng.enterEditMode(); setEditOpen(true); } }); // keep editing when browsing to another clip
  // Loading a different clip while the current one has unsaved edits: prompt to save first.
  const tryLoadClip = (clip: Clip) => { const e = engineRef.current; if (e?.hasCurrentEdits() && clip.id !== currentClipId) setLoadConfirm({ clip, name: (editState.clip || 'anim') + '_Edited' }); else playClip(clip); };
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
    const e = engineRef.current; if (!e) return;
    e.applyCameraPreset(camPreset);
    e.setFacing(camPreset === 'iso' ? (facing ?? 0) : 0); // only the iso camera uses the facing compass; every other view faces the character at the camera
  }, [camPreset]); // eslint-disable-line react-hooks/exhaustive-deps
  // Overlay camera buttons apply imperatively (not just via the camPreset effect): dragging in iso
  // silently drifts the engine back to orbit, so re-picking 'iso' must re-apply even though the React
  // camPreset value is unchanged - a plain setCamPreset('iso') would be a no-op and nothing would happen.
  const applyCam = (p: CamPreset) => {
    setCamPreset(p);
    const e = engineRef.current; if (!e) return;
    if (p === 'orbit') { e.setAutoFrame(isMobile); e.recenter(); } // orbit always snaps to the default front view, independent of any iso angle/facing
    else e.applyCameraPreset(p);
    e.setFacing(p === 'iso' ? (facing ?? 0) : 0); // iso keeps its own compass facing; orbit/front/portrait face the character at the camera
  };
  // The orbit button always snaps back to the default centred front view (a quick reset after panning/
  // zooming, and a clean exit from iso that ignores its facing/angle). Restores mobile auto-framing.
  const recenterView = () => applyCam('orbit');
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
    if (kind === 'png') { const [w, h] = evenDims(aspect, exp.pngRes); onProgress(1); return { blob: await exportPng(eng, w, h, bg), ext: 'png' }; }
    if (kind === 'gif') { const [w, h] = evenDims(aspect, exp.gifRes); return { blob: await exportGif(eng, w, h, bg, { mode: gifMode, seconds: 5, fps: exp.gifFps, speed, content, colors: exp.gifColors, onProgress }), ext: 'gif' }; }
    const [w, h] = evenDims(aspect, exp.mp4Res); return exportVideo(eng, w, h, bg, { seconds: mp4Seconds, fps: exp.mp4Fps, content, codec: exp.mp4Codec, quality: exp.mp4Quality, onProgress });
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

  // Developer-mode export: a compact, human-readable JSON of the whole current character + scene - what's
  // equipped, its meshes/textures/sources, hair/beard/body/skin, the animation and scene. Joins the engine's
  // live equipped state with the React catalogs (which carry the mod source + mesh/texture names). Deliberately
  // omits bulky data (per-keyframe pose data, raw texture bytes) so it stays readable.
  const buildCharacterData = () => {
    const eng = engineRef.current;
    const g = eng?.gender ?? gender;
    const clothingByName = new Map(clothing.map((c) => [c.name, c]));
    const heldByName = new Map(held.map((h) => [h.name, h]));
    const disp = (name: string) => { const d = nameToLabel.get(name); return d && d !== name ? d : undefined; };
    const worn = eng?.clothingState() ?? [];
    const carried = eng?.heldState() ?? [];
    const hairStyle = hairSel !== 'None' ? findHairByName(hairSel, g) : null;
    const beardStyle = beardSel !== 'None' ? findBeardByName(beardSel) : null;
    const bodySrc = bodySources.find((b) => b.id === bodySourceId) ?? null;
    const bodyMod = bodySrc ? (bodySrc as { modId?: string | null }).modId ?? null : null;
    return {
      exportedAt: new Date().toISOString(),
      generator: 'PZ Survivor Studio (pz-icon-maker)',
      character: {
        gender: g,
        skinTone: skin,
        body: bodySrc ? { source: bodySrc.label, mod: bodyMod, id: bodySrc.id } : { source: 'Vanilla (default body)' },
        uvCompatibility: eng?.uvVerdict() ?? null,
        hair: hairStyle ? { name: hairStyle.name, model: hairStyle.model ?? null, texture: hairStyle.texture ?? null, source: hairStyle.modName ?? 'Vanilla', color: hairColor } : null,
        beard: beardStyle ? { name: beardStyle.name, model: beardStyle.model ?? null, texture: beardStyle.texture ?? null, source: beardStyle.modName ?? 'Vanilla', color: beardColor } : null,
      },
      clothing: worn.map((w) => { const c = clothingByName.get(w.name); return {
        name: w.name, display: disp(w.name), source: c?.source ?? c?.modName ?? 'Vanilla', mod: c?.modId ?? null,
        kind: c?.kind ?? null, bodyLocation: c?.location ?? null, model: (g === 'female' ? c?.femaleModel : c?.maleModel) ?? null,
        tintable: c?.allowTint ?? false, tint: w.tint, hidden: w.hidden,
      }; }),
      held: carried.map((h) => { const it = heldByName.get(h.name); return {
        name: h.name, display: disp(h.name), hand: h.hand, source: it?.source ?? it?.modName ?? 'Vanilla',
        mesh: it?.mesh ?? null, texture: it?.texture ?? null, scale: it?.scale ?? null, tags: it?.tags ?? [],
        attachments: h.attachments?.map((a) => ({ slot: a.slot, option: a.option })) ?? [], hidden: h.hidden,
      }; }),
      animation: { clip: editState.clip, editable: editState.editable, hasUnsavedEdits: eng?.hasCurrentEdits() ?? false, editedBones: eng?.editedBoneNames() ?? [] },
      scene: { camera: camPreset, aspect: studioAspect, turntable, floor: floorSel, background: bg, lighting: light },
    };
  };
  const runCharacterDataExport = () => {
    try {
      const json = JSON.stringify(buildCharacterData(), null, 2);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      download(new Blob([json], { type: 'application/json' }), `pz-character-data-${stamp}.json`);
      setNowPlaying('exported character data (JSON)');
    } catch (e) { setNowPlaying('character data export failed: ' + (e instanceof Error ? e.message : String(e))); }
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
        props: eng.propsState(), tiles: eng.tilesState(),
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
    setFacing(s.facing); eng?.setFacing(s.camPreset === 'iso' && s.facing != null ? s.facing : 0); // the facing compass only applies under iso; other cameras face the character forward
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
    props: engineRef.current?.propsState() ?? [],
    tiles: engineRef.current?.tilesState() ?? [],
    scene: { bg, turntable, camPreset, studioAspect, facing, floor: floorSel, light, grid, shadow },
  });
  // Front-35mm portrait snapshot of the current character (facing the camera), for the preset card.
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
    await loadTiles(preset.tiles); // placed 2D tiles (build tab)
    await loadProps(preset.props); // placed 3D props (build tab) - after the body + scene exist (bone attachments need the skeleton)
    engineRef.current?.resetHistory(); // a loaded preset is a fresh start, not undo steps back into the old scene
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
    // Each tab stays MOUNTED and is toggled with display (contents when active, none when hidden) rather
    // than conditionally rendered, so its AssetGrid keeps its search/facet/sort/scroll when you leave and
    // come back. `display: contents` means the active pane lays out exactly as if the wrapper weren't there.
    <div style={{ flex: 1, minHeight: 0 }}>
      <div style={{ display: tab === 'animate' ? 'contents' : 'none' }}>{(
        <AssetGrid<typeof clipItems[number] & GridItem>
          items={clipItems as (typeof clipItems[number] & GridItem)[]}
          facetLabel="categories"
          active={(it) => it.id === currentClipId}
          onPick={(it) => tryLoadClip(it)}
          extraControls={(
            <button className="secondary" onClick={() => pose.setPosesOpen(true)}
              title="Browse and apply your custom saved poses"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '0 10px', height: 30, borderRadius: 6, border: '1px solid var(--line)', whiteSpace: 'nowrap' }}>
              <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M12 2 3 7v10l9 5 9-5V7z" /><circle cx={12} cy={12} r={3} /></svg>
              Saved poses{Object.keys(pose.posePresets).length ? ` (${Object.keys(pose.posePresets).length})` : ''}
            </button>
          )}
          renderThumb={(it) => <ClipThumb clip={it} thumbs={thumbs} preview={preview} />} />
      )}</div>
      <div style={{ display: tab === 'clothing' ? 'contents' : 'none' }}>{(
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
      )}</div>
      <div style={{ display: tab === 'held' ? 'contents' : 'none' }}>{(
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
      )}</div>
      <div style={{ display: tab === 'build' ? 'flex' : 'none', flexDirection: 'column', height: '100%', minHeight: 0 }}>
        <div style={{ display: 'flex', gap: 4, padding: 6, borderBottom: '1px solid var(--line)', flexShrink: 0 }}>
          {(['2d', '3d'] as const).map((t) => (
            <button key={t} className="secondary" onClick={() => setBuildTab(t)}
              style={{ flex: 1, padding: '7px 10px', fontSize: 12.5, fontWeight: 600, borderRadius: 7, cursor: 'pointer', background: buildTab === t ? 'var(--accent)' : 'transparent', color: buildTab === t ? '#fff' : 'var(--text)', border: `1px solid ${buildTab === t ? 'var(--accent)' : 'var(--line)'}` }}>{t === '2d' ? '2D Tiles' : '3D Props'}</button>
          ))}
        </div>
        <div style={{ display: buildTab === '2d' ? 'flex' : 'none', flexDirection: 'column', flex: 1, minHeight: 0 }}>{(
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
            <div style={{ padding: '6px 8px', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', borderBottom: '1px solid var(--line)' }}>
              <span style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.05em' }}>mode</span>
              <BuildModeChips buildMode={buildMode} rectMode={rectMode} onMode={applyBuildMode} onRect={applyRectMode} showRect={isMobile} />
              {buildMode === 'erase' && <EraseDepthStepper depth={eraseDepth} onChange={applyEraseDepth} />}
              <div style={{ marginLeft: 'auto' }}>
                <HistoryButtons canUndo={canUndo} canRedo={canRedo} onUndo={() => engineRef.current?.undo()} onRedo={() => engineRef.current?.redo()} />
              </div>
            </div>
            <div style={{ flex: 1, minHeight: 0 }}>
              <AssetGrid<typeof tileItems[number] & GridItem>
                key={tileCat}
                items={tileItems as (typeof tileItems[number] & GridItem)[]}
                facetLabel="sheets"
                active={(it) => it.setId === selectedSet}
                onPick={(it) => pickSet(it)}
                renderThumb={(it) => <Thumb depKey={`grp:${it.thumbTiles.map((t) => t.tile.name).join(',')}`} getUrl={() => tileLib.compositeThumb(it.thumbTiles)} />} />
            </div>
            <div style={{ padding: '8px 12px', borderTop: '1px solid var(--line)', fontSize: 12, color: 'var(--muted)', lineHeight: 1.4 }}>
              {selectedTileInfo ? <><b style={{ color: 'var(--text)' }}>Click or drag</b> to place. Shift before dragging fills a rectangle; Shift during a drag locks a straight line. Erase mode (or right-click) removes; the red item is what goes. Keys: <b>E</b> erase, <b>R</b> / <b>Shift+R</b> next/prev piece (in erase: cycle layer), <b>1-9</b> pick piece, <b>Ctrl+Z / Ctrl+Y</b> undo/redo. Touch: one finger acts, two fingers pan/zoom. Rugs, walls and furniture stack (a lamp goes on a table).</>
                : 'Pick a tile, then click the ground (in the PZ-iso view) to place it.'}
            </div>
          </div>
        )
      )}</div>
        <div style={{ display: buildTab === '3d' ? 'flex' : 'none', flexDirection: 'column', flex: 1, minHeight: 0 }}>
          {propItems.length === 0 ? (
            <div style={{ padding: 20, color: 'var(--muted)', fontSize: 13, lineHeight: 1.55 }}>
              Loading 3D item models needs your installed game files. Switch to <b>use my game files</b> (local mode) to browse and place props.
            </div>
          ) : (
            <AssetGrid<typeof propItems[number] & GridItem>
              items={propItems as (typeof propItems[number] & GridItem)[]}
              facetLabel="categories"
              active={(it) => it.rec.item === placingProp}
              onPick={(it) => placeProp(it.rec)}
              renderThumb={(it) => <Thumb depKey={`prop:${it.rec.item}`} getUrl={() => thumbs.prop(it.rec)} />} />
          )}
          <div style={{ padding: '8px 12px', borderTop: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 14, fontSize: 12, color: 'var(--muted)' }}>
            <span style={{ fontSize: 10, letterSpacing: '.04em' }}>NEW PROPS</span>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4 }} title="New props start sticky-armed (a drag onto the character or another prop attaches + follows)"><input type="checkbox" checked={stickyDefault} onChange={(e) => toggleStickyDefault(e.target.checked)} />sticky</label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4 }} title="New props orient to the surface they are dropped on (live preview while dragging)"><input type="checkbox" checked={alignDefault} onChange={(e) => toggleAlignDefault(e.target.checked)} />align to surface</label>
          </div>
          <div style={{ padding: '8px 12px', borderTop: '1px solid var(--line)', fontSize: 12, color: 'var(--muted)', lineHeight: 1.4 }}>
            Pick an item, then <b style={{ color: 'var(--text)' }}>click</b> to drop it (on the character or a prop it sticks + follows; right-click or Esc cancels). Placed props can be clicked and moved from <b style={{ color: 'var(--text)' }}>any tab</b>; select one to open its controls, then <b style={{ color: 'var(--text)' }}>G</b> move, <b style={{ color: 'var(--text)' }}>R</b> rotate, <b style={{ color: 'var(--text)' }}>S</b> scale.
          </div>
        </div>
      </div>
      <div style={{ display: tab === 'character' ? 'contents' : 'none' }}><CharacterTab hairData={hairData} gender={gender} setGender={setGender} skin={skin} tones={tones} zombieSkins={zombieSkins} skinThumbUrl={skinThumbUrl} bodyOptions={bodySources.map((b) => ({ id: b.id, label: b.label }))} bodySel={bodySourceId || bodySources[0]?.id || ''} onBody={changeBody} uvVerdict={uvVerdict} textureOptions={texSources.map((t) => ({ id: t.id, label: t.label }))} textureSel={texSourceId || texSources[0]?.id || ''} onTexture={changeTexture} onSkin={(t) => { setSkin(t); engineRef.current?.setSkin(t); }} thumbs={thumbs} hairSel={hairSel} beardSel={beardSel} hairColor={hairColor} beardColor={beardColor} matchBeard={matchBeard} onToggleMatchBeard={toggleMatchBeard} onPickPart={applyHairPart} onRecolour={recolourPart} favs={favs} onToggleFav={toggleFav} onImport={() => setImportOpen(true)} onNew={() => { void newCharacter(); }}
        savedCount={Object.keys(presets).length} onOpenSaved={() => setPresetsOpen(true)}
        dressShown={dressState.shown} dressWorn={dressState.worn} onToggleDress={(on) => engineRef.current?.setDressVisible(on)} /></div>
      <div style={{ display: tab === 'export' ? 'contents' : 'none' }}>{(
        <div style={{ padding: 12, overflow: 'auto', height: '100%' }}>
          <ExportSection cloud={cloud}
            studio={{ camPreset, setCamPreset, studioAspect, setStudioAspect, bg, setBg, turntable, setTurntable, gifMode, setGifMode, mp4Seconds, setMp4Seconds, exp, setExp, devMode, onExportCharacterData: runCharacterDataExport, exporting, runExport }} />
        </div>
      )}</div>
    </div>
  );

  return (
    <div ref={containerRef} style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', gap: isMobile ? 8 : 0, height: isMobile ? (mobileViewH || '80vh') : 'calc(100vh - 128px)', minHeight: isMobile ? 0 : 460 }}>
      {importOpen && <ImportModal onClose={() => setImportOpen(false)} onImport={applyImport} />}
      {resetConfirm && idleClip && (
        <div style={{ position: 'fixed', inset: 0, background: '#000000aa', zIndex: 400, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => setResetConfirm(null)}>
          <div onClick={(e) => e.stopPropagation()} style={{ width: 430, maxWidth: '92vw', background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 10, padding: 18 }}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>Unsaved animation edits</div>
            <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5, marginBottom: 14 }}>The current animation has unsaved pose edits. Save them as a pose before resetting to the vanilla idle?</div>
            <input value={resetConfirm.name} onChange={(e) => setResetConfirm({ name: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter' && resetConfirm.name.trim()) { pose.savePose(resetConfirm.name.trim()); engineRef.current?.forgetClipEdits(idleClip); playClip(idleClip); setResetConfirm(null); } }} placeholder="pose name" style={{ width: '100%', boxSizing: 'border-box', background: '#14141a', color: 'var(--text)', border: '1px solid var(--line)', borderRadius: 6, padding: '8px 10px', fontSize: 13, marginBottom: 14 }} />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
              <button className="secondary" onClick={() => setResetConfirm(null)} style={{ padding: '8px 14px' }}>Cancel</button>
              <button className="secondary" onClick={() => { engineRef.current?.forgetClipEdits(idleClip); playClip(idleClip); setResetConfirm(null); }} style={{ padding: '8px 14px' }}>Discard & reset</button>
              <button disabled={!resetConfirm.name.trim()} onClick={() => { pose.savePose(resetConfirm.name.trim()); engineRef.current?.forgetClipEdits(idleClip); playClip(idleClip); setResetConfirm(null); }} style={{ padding: '8px 14px' }}>Save & reset</button>
            </div>
          </div>
        </div>
      )}
      {loadConfirm && (
        <div style={{ position: 'fixed', inset: 0, background: '#000000aa', zIndex: 400, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => setLoadConfirm(null)}>
          <div onClick={(e) => e.stopPropagation()} style={{ width: 440, maxWidth: '92vw', background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 10, padding: 18 }}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>Unsaved animation edits</div>
            <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5, marginBottom: 14 }}>You have unsaved edits to <b>{editState.clip}</b>. Save them as a pose before loading <b>{loadConfirm.clip.name}</b>?</div>
            <input value={loadConfirm.name} onChange={(e) => setLoadConfirm((c) => c && { ...c, name: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter' && loadConfirm.name.trim()) { pose.savePose(loadConfirm.name.trim()); playClip(loadConfirm.clip); setLoadConfirm(null); } }} placeholder="pose name" style={{ width: '100%', boxSizing: 'border-box', background: '#14141a', color: 'var(--text)', border: '1px solid var(--line)', borderRadius: 6, padding: '8px 10px', fontSize: 13, marginBottom: 14 }} />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
              <button className="secondary" onClick={() => setLoadConfirm(null)} style={{ padding: '8px 14px' }}>Cancel</button>
              <button className="secondary" onClick={() => { playClip(loadConfirm.clip); setLoadConfirm(null); }} style={{ padding: '8px 14px' }}>Discard & load</button>
              <button disabled={!loadConfirm.name.trim()} onClick={() => { pose.savePose(loadConfirm.name.trim()); playClip(loadConfirm.clip); setLoadConfirm(null); }} style={{ padding: '8px 14px' }}>Save & load</button>
            </div>
          </div>
        </div>
      )}
      {presetsOpen && <PresetsModal presets={presets} onClose={() => setPresetsOpen(false)} onSave={savePreset} onLoad={(p) => { void applyPreset(p); setPresetsOpen(false); }} onDelete={deletePreset} onDuplicate={duplicatePreset} />}
      {pose.posesOpen && <PosesModal poses={pose.posePresets} currentClip={editState.clip} clips={clipItems} preview={preview} onClose={() => pose.setPosesOpen(false)} onSave={(n) => pose.savePose(n)} onLoad={(n) => pose.loadPose(n)} onDelete={(n) => pose.deletePose(n)} />}
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
          {(() => { void boneTick; return !editState.active && pose.dirty && engineRef.current?.hasCurrentEdits(); })() && (
            <span title="This animation has unsaved pose edits. Save it from the pose editor, or Idle will offer to save before it resets." style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: '#ffd23f', background: '#00000099', padding: '4px 8px', borderRadius: 6, fontSize: isMobile ? 11 : 12, whiteSpace: 'nowrap', flexShrink: 0 }}>
              <span style={{ width: 7, height: 7, borderRadius: 999, background: '#ffd23f', flexShrink: 0 }} />Unsaved edits
            </span>
          )}
          {idleClip && <button data-tour="idle" className="secondary" title="Reset to idle animation" onClick={() => { const e = engineRef.current; if (e?.hasCurrentEdits()) setResetConfirm({ name: (editState.clip || 'anim') + '_Edited' }); else { e?.forgetClipEdits(idleClip); playClip(idleClip); } }} style={{ padding: isMobile ? '9px 14px' : '4px 10px', fontSize: isMobile ? 14 : 12, lineHeight: 1, flexShrink: 0 }}>↺ Idle</button>}
        </div>
        <div style={{ position: 'absolute', right: isMobile ? 8 : 12, top: isMobile ? 8 : 12, display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-end' }}>
          <div style={{ display: 'flex', gap: isMobile ? 6 : 8, alignItems: 'flex-start', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <button className="secondary" title="Equipped items" aria-label="Equipped items" onClick={() => { setEquipOpen((v) => !v); setSceneOpen(false); setInspectorOpen(false); setEditOpen(false); }}
              style={{ position: 'relative', borderRadius: 6, padding: isMobile ? 0 : '7px 12px', width: isMobile ? 36 : undefined, height: isMobile ? 36 : undefined, display: isMobile ? 'grid' : undefined, placeItems: isMobile ? 'center' : undefined, fontSize: 13, lineHeight: 1, border: '1px solid var(--line)', background: equipOpen ? 'var(--accent)' : 'var(--panel)', color: equipOpen ? '#fff' : 'var(--text)' }}>
              {isMobile ? (<><ShirtIcon />{(equipList.length + bodyEquip.length) > 0 && <span style={{ position: 'absolute', top: -6, right: -6, minWidth: 16, height: 16, padding: '0 4px', borderRadius: 999, background: 'var(--accent)', color: '#fff', fontSize: 10.5, fontWeight: 700, display: 'grid', placeItems: 'center', border: '1.5px solid #0e0e13' }}>{equipList.length + bodyEquip.length}</span>}</>) : `Equipped${(equipList.length + bodyEquip.length) ? ` (${equipList.length + bodyEquip.length})` : ''}`}
            </button>
            <button data-tour="scenebtn" className="secondary" title="Scene, lighting & floor" aria-label="Scene, lighting and floor" onClick={() => { setSceneOpen((v) => !v); setEquipOpen(false); setInspectorOpen(false); setEditOpen(false); }}
              style={{ borderRadius: 6, padding: isMobile ? 0 : '7px 12px', width: isMobile ? 36 : undefined, height: isMobile ? 36 : undefined, display: isMobile ? 'grid' : undefined, placeItems: isMobile ? 'center' : undefined, fontSize: 13, lineHeight: 1, border: '1px solid var(--line)', background: sceneOpen ? 'var(--accent)' : 'var(--panel)', color: sceneOpen ? '#fff' : 'var(--text)' }}>
              {isMobile ? <SunIcon /> : 'Scene'}
            </button>
            {!isMobile && (
              <button title="Pose editor - edit the current animation and browse clips" aria-label="Pose editor" onClick={() => { const e = engineRef.current; if (!e) return; if (editState.active && editOpen) { e.exitEditMode(); return; } if (editState.active) { setEditOpen(true); return; } setTab('animate'); setDrawerOpen(true); setSceneOpen(false); setEquipOpen(false); setInspectorOpen(false); if (editState.editable) { e.enterEditMode(); setEditOpen(true); } }}
                style={{ borderRadius: 6, padding: '7px 12px', fontSize: 13, lineHeight: 1, border: `1px solid ${editState.active ? 'var(--accent)' : 'var(--line)'}`, background: editState.active ? 'var(--accent)' : 'var(--panel)', color: editState.active ? '#fff' : 'var(--text)' }}>Pose</button>
            )}
            {selectedProp && !isMobile && (
              <button title="Selected prop controls" aria-label="Selected prop controls" onClick={() => { setInspectorOpen((v) => !v); setSceneOpen(false); setEquipOpen(false); setEditOpen(false); }}
                style={{ borderRadius: 6, padding: isMobile ? 0 : '7px 12px', width: isMobile ? 36 : undefined, height: isMobile ? 36 : undefined, display: isMobile ? 'grid' : undefined, placeItems: isMobile ? 'center' : undefined, fontSize: 13, lineHeight: 1, border: '1px solid var(--line)', background: inspectorOpen ? 'var(--accent)' : 'var(--panel)', color: inspectorOpen ? '#fff' : 'var(--text)' }}>
                {isMobile ? <BoxIcon /> : (selectedProp.count > 1 ? `Props (${selectedProp.count})` : 'Prop')}
              </button>
            )}
            <div data-tour="camera" style={{ display: 'flex', border: '1px solid var(--line)', borderRadius: 6, overflow: 'hidden', height: isMobile ? 36 : undefined }}>
              <button className="secondary" title={camMode === 'orbit' ? 'Free orbit (click again to recenter, facing the camera)' : 'Free orbit (faces the character at the camera)'} onClick={recenterView}
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
            <div title="Facing" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 34px)', gap: 3, background: '#0e0e13cc', border: '1px solid var(--line)', borderRadius: 8, padding: 5, position: 'relative', zIndex: 30, marginRight: (!isMobile && editState.active && editOpen) ? 312 : 0 }}>
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
        {/* Selected-prop inspector: same panel style as Scene/Equipped, anchored under the Prop button. */}
        {selectedProp && inspectorOpen && !isMobile && (() => {
          const sp = selectedProp;
          const multi = sp.count > 1; // several props selected: shared actions only (texture/attachments are single-prop)
          const secLabel: React.CSSProperties = { fontSize: 10, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--muted)', marginBottom: 4 };
          const btn = (accent = false, danger = false): React.CSSProperties => ({ padding: '4px 9px', fontSize: 11, borderRadius: 6, cursor: 'pointer', border: `1px solid ${danger ? '#c0392b' : accent ? 'var(--accent)' : 'var(--line)'}`, background: accent ? 'var(--accent)' : 'var(--panel)', color: danger ? '#e74c3c' : accent ? '#fff' : 'var(--text)' });
          const chip = (active: boolean): React.CSSProperties => ({ padding: '2px 8px', fontSize: 11, borderRadius: 6, cursor: 'pointer', maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', border: '1px solid var(--line)', background: active ? 'var(--accent)' : 'var(--panel)', color: active ? '#fff' : 'var(--text)' });
          const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 11, color: 'var(--muted)' };
          const slots = heldSlots.get(sp.name);
          const cur = (slot: string) => sp.attachments.find((a) => a.slot === slot)?.partName ?? null;
          return (
            <div style={{ position: 'absolute', right: isMobile ? 6 : 12, top: isMobile ? 48 : 54, width: isMobile ? 'min(300px, calc(100% - 12px))' : 280, maxHeight: '74%', overflow: 'auto', background: '#0e0e13f2', border: '1px solid var(--line)', borderRadius: 8, padding: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <span style={{ fontSize: 12, color: 'var(--text)', maxWidth: 210, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{multi ? `${sp.count} props selected` : sp.name}</span>
                <span role="button" onClick={() => setInspectorOpen(false)} title="Close (the prop stays selected)" style={{ cursor: 'pointer', color: 'var(--muted)', padding: '0 4px' }}>✕</span>
              </div>
              <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                {!multi && <button className="secondary" onClick={() => toggleGizmo(!showGizmo)} title="Show draggable gizmo handles (otherwise use G / R / S)" style={btn(showGizmo)}>gizmos</button>}
                <button className="secondary" onClick={() => engineRef.current?.duplicateSelectedProp()} title={multi ? 'Duplicate all selected (Ctrl+D)' : 'Duplicate (Ctrl+D)'} style={btn()}>duplicate</button>
                <button className="secondary" onClick={() => engineRef.current?.resetSelectedProp()} title={multi ? 'Reset rotation + scale on all selected' : 'Reset rotation + scale'} style={btn()}>reset</button>
                <button className="secondary" onClick={() => engineRef.current?.deleteSelectedProp()} title={multi ? 'Delete all selected (Del)' : 'Delete (Del)'} style={btn(false, true)}>delete</button>
                <button className="secondary" onClick={() => engineRef.current?.selectProp(null)} title="Deselect" style={btn()}>deselect</button>
              </div>
              {multi && <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 6 }}>{isMobile ? 'Transforms and Select apply to all selected. Texture and attachments are single-prop.' : 'G / R / S transform all selected around their shared centre. Texture and attachments are single-prop.'}</div>}
              {showGizmo && !multi && (
                <div style={{ display: 'flex', gap: 5, marginTop: 6 }}>
                  {(['translate', 'rotate', 'scale'] as const).map((m) => (
                    <button key={m} className="secondary" onClick={() => applyGizmoMode(m)} style={btn(gizmoMode === m)}>{m === 'translate' ? 'move' : m}</button>
                  ))}
                </div>
              )}
              <div style={{ borderTop: '1px solid var(--line)', marginTop: 10, paddingTop: 9 }}>
                <div style={secLabel}>Sticky</div>
                <div style={row}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 3 }} title="When on, dragging this prop onto the character or another prop makes it stick and follow"><input type="checkbox" checked={sp.sticky} onChange={(e) => setPropSticky(e.target.checked)} />sticky</label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 3, opacity: sp.sticky ? 1 : 0.4 }} title="On attach, orient the prop to the surface (vs keep its current rotation)"><input type="checkbox" checked={sp.align} disabled={!sp.sticky} onChange={(e) => setPropAlign(e.target.checked)} />align</label>
                  {multi
                    ? <button className="secondary" onClick={detachProp} title="Release any attachments in the selection (props stay put)" style={btn()}>detach all</button>
                    : sp.attached
                    ? <button className="secondary" onClick={detachProp} title="Release the attachment (prop stays put)" style={btn()}>detach</button>
                    : <span style={{ opacity: 0.6 }}>{sp.sticky ? 'drag onto a target' : 'grounded'}</span>}
                </div>
                {!multi && sp.attached && (
                  <div style={{ marginTop: 6, fontSize: 11, color: 'var(--accent)', wordBreak: 'break-all', lineHeight: 1.35 }}>on {sp.attached}</div>
                )}
              </div>
              {!multi && (
              <div style={{ borderTop: '1px solid var(--line)', marginTop: 10, paddingTop: 9 }}>
                <div style={secLabel}>Texture</div>
                <div style={row}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 3 }}><input type="checkbox" checked={sp.texXf.flipU} onChange={(e) => applyPropTexXf({ ...sp.texXf, flipU: e.target.checked })} />flip U</label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 3 }}><input type="checkbox" checked={sp.texXf.flipV} onChange={(e) => applyPropTexXf({ ...sp.texXf, flipV: e.target.checked })} />flip V</label>
                  <button className="secondary" onClick={() => applyPropTexXf({ ...sp.texXf, rot: (sp.texXf.rot + 90) % 360 })} title="rotate texture 90 degrees" style={btn()}>rot {sp.texXf.rot}</button>
                </div>
              </div>
              )}
              {!multi && slots?.length ? (
                <div style={{ borderTop: '1px solid var(--line)', marginTop: 10, paddingTop: 9 }}>
                  <div style={secLabel}>Attachments</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                    {slots.map((s) => (
                      <div key={s.slot} style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', fontSize: 11 }}>
                        <span style={{ minWidth: 50, color: 'var(--text)' }}>{s.slot}</span>
                        <button className="secondary" onClick={() => setPropAttach(s.slot, null)} style={chip(cur(s.slot) === null)}>None</button>
                        {s.options.map((o) => (<button key={o.partName} className="secondary" title={o.partName} onClick={() => setPropAttach(s.slot, o)} style={chip(cur(s.slot) === o.partName)}>{o.partName}</button>))}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          );
        })()}
        {marqueeRect && marqueeRect.w > 1 && marqueeRect.h > 1 && (
          <div style={{ position: 'absolute', left: marqueeRect.x, top: marqueeRect.y, width: marqueeRect.w, height: marqueeRect.h, border: '1px solid var(--accent)', background: '#5b8cff22', pointerEvents: 'none', zIndex: 6 }} />
        )}
        {twistInfo && (() => {
          const col: Record<string, string> = { view: '#ffffff', x: '#ff5b5b', y: '#5bff8c', z: '#5b8cff' }; // Screen is white so it never collides with the blue Z axis
          const c = col[twistInfo.axis];
          const R = 26, min = 0.16;
          const ang = Math.atan2(twistInfo.dir.y, twistInfo.dir.x) * 180 / Math.PI; // orient the ring's edge-on axis along the projected axle
          const rx = R * Math.max(twistInfo.tilt, min); // squash toward an edge-on ellipse as the axle lies in the screen plane
          const axleLen = R * 1.5 * (1 - twistInfo.tilt); // the axle only sticks out when it is not pointing at the camera
          return (
            <svg width={80} height={80} viewBox="-40 -40 80 80" style={{ position: 'absolute', left: twistInfo.x - 40, top: twistInfo.y - 40, pointerEvents: 'none', zIndex: 7, overflow: 'visible' }}>
              <g transform={`rotate(${ang})`}>
                {axleLen > 3 && <line x1={-axleLen} y1={0} x2={axleLen} y2={0} stroke={c} strokeWidth={2} strokeLinecap="round" opacity={0.85} />}
                <ellipse cx={0} cy={0} rx={rx} ry={R} fill="none" stroke={c} strokeWidth={2.5} opacity={0.95} />
              </g>
              <circle cx={0} cy={0} r={2.5} fill={c} />
            </svg>
          );
        })()}
        {editState.active && (isMobile || editOpen) && (
          <PoseEditorPanel
            pose={pose}
            engine={engineRef.current}
            editState={editState}
            selectedBones={selectedBones}
            saveAsName={saveAsName}
            setSaveAsName={setSaveAsName}
            boneSearch={boneSearch}
            isMobile={isMobile}
            bottomBarH={bottomBarH}
            boneTick={boneTick}
            bump={() => setBoneTick((t) => t + 1)}
          />
        )}
        <div ref={bottomBarRef} style={{ position: 'absolute', left: 12, bottom: 12, right: 12, background: '#0e0e13f2', border: '1px solid rgba(255,255,255,.08)', borderRadius: 10, overflow: 'hidden', boxShadow: '0 12px 34px -14px rgba(0,0,0,.7)' }}>
          {editState.active && (() => {
            void boneTick; const eng = engineRef.current; if (!eng) return null;
            return (
              <Dopesheet
                engine={eng}
                boneTick={boneTick}
                bump={() => setBoneTick((t) => t + 1)}
                keySel={keySel}
                setKeySel={setKeySel}
                scrubbingRef={scrubbingRef}
                playheadRef={playheadRef}
                trackGeomRef={trackGeomRef}
                onToast={setNowPlaying}
                isMobile={isMobile}
                playing={playing} onTogglePlay={togglePlay} onReplay={() => { engineRef.current?.replay(); setPlaying(true); }}
                loop={loop} onToggleLoop={() => { const n = !loop; setLoop(n); engineRef.current?.setLoop(n); }}
                speed={speed} onSpeed={(s) => { setSpeed(s); engineRef.current?.setSpeed(s); }}
              />
            );
          })()}
          {!editState.active && ( // the dopesheet toolbar carries the transport while editing; this standalone bar is for plain playback
          <div style={{ display: 'flex', gap: isMobile ? 6 : 8, alignItems: 'center', padding: isMobile ? '6px 8px' : '6px 10px' }}>
          <button className="secondary" onClick={togglePlay} style={{ padding: isMobile ? '4px 10px' : '4px 12px', flexShrink: 0 }}>{playing ? '❚❚' : '▶'}</button>
          <button className="secondary" title="Play from the start" aria-label="Replay from start" onClick={() => { engineRef.current?.replay(); setPlaying(true); }}
            style={{ padding: 0, width: isMobile ? 32 : 30, height: isMobile ? 30 : 28, display: 'grid', placeItems: 'center', flexShrink: 0 }}><RestartIcon size={isMobile ? 16 : 15} /></button>
          {editState.active && !isMobile
            ? <span style={{ flex: 1 }} /> // in edit mode the dopesheet strip above is the scrubber
            : <input ref={scrubRef} type="range" min={0} max={1000} defaultValue={0}
                onMouseDown={() => { scrubbingRef.current = true; }} onMouseUp={() => { scrubbingRef.current = false; }}
                onInput={(e) => engineRef.current?.seek(Number((e.target as HTMLInputElement).value) / 1000)}
                style={{ flex: 1, minWidth: 0, accentColor: '#5b8cff' }} />}
          <button className="secondary" onClick={() => { const n = !loop; setLoop(n); engineRef.current?.setLoop(n); }}
            style={{ padding: isMobile ? '4px 9px' : '4px 10px', flexShrink: 0, background: loop ? 'var(--accent)' : 'var(--panel)', color: loop ? '#fff' : 'var(--text)' }}>loop</button>
          {editState.editable && isMobile && (
            <button className="secondary" title={editState.active ? 'Exit pose editing' : 'Edit this animation pose'} onClick={() => { const e = engineRef.current; if (!e) return; if (editState.active) e.exitEditMode(); else e.enterEditMode(); }}
              style={{ padding: '4px 9px', flexShrink: 0, background: editState.active ? 'var(--accent)' : 'var(--panel)', color: editState.active ? '#fff' : 'var(--text)' }}>edit</button>
          )}
          <select value={speed} onChange={(e) => { const s = Number(e.target.value); setSpeed(s); engineRef.current?.setSpeed(s); }}
            style={{ background: 'var(--panel)', color: 'var(--text)', border: '1px solid var(--line)', borderRadius: 6, padding: '4px 6px', flexShrink: 0 }}>
            {[0.25, 0.5, 1, 2].map((s) => <option key={s} value={s}>{s}×</option>)}
          </select>
          </div>
          )}
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


      {/* Placement hint: while a prop rides the cursor, show what a click will drop it onto. */}
      {placeHint && (
        <div style={{ position: 'fixed', top: 'calc(env(safe-area-inset-top, 0px) + 10px)', left: '50%', transform: 'translateX(-50%)', zIndex: 67, pointerEvents: 'none', display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px', fontSize: 12, background: 'var(--panel)', border: `1px solid ${placeHint === 'floor' ? 'var(--line)' : 'var(--accent)'}`, borderRadius: 999, boxShadow: '0 8px 28px #000a' }}>
          <span style={{ color: 'var(--muted)' }}>click to place</span>
          {placeHint === 'floor'
            ? <span style={{ color: 'var(--text)' }}>on the floor</span>
            : <span style={{ color: 'var(--accent)', fontWeight: 600 }}>{placeHint === 'character' ? 'on the character (sticks + follows)' : 'on the prop (sticks + follows)'}</span>}
        </div>
      )}

      {/* Active Blender-style modal transform: status + how to confirm/cancel/lock. */}
      {modalLabel && (
        <div style={{ position: 'fixed', bottom: 'calc(env(safe-area-inset-bottom, 0px) + 16px)', left: '50%', transform: 'translateX(-50%)', zIndex: 67, pointerEvents: 'none', display: 'flex', alignItems: 'center', gap: 10, padding: '7px 14px', fontSize: 12, background: 'var(--panel)', border: '1px solid var(--accent)', borderRadius: 999, boxShadow: '0 8px 28px #000a' }}>
          <span style={{ color: 'var(--accent)', fontWeight: 700 }}>{modalLabel}</span>
          <span style={{ color: 'var(--muted)' }}>X Y Z lock axis · click or Enter confirm · Esc cancel</span>
        </div>
      )}

      {/* Desktop: the open set's pieces as a draggable hotbar over the canvas (1-9 shortcuts), with a
          Place/Erase toggle stacked at its left. */}
      {!isMobile && tab === 'build' && selectedSetObj && selectedSetObj.pieces.length > 1 && (
        <BuildHotbar set={selectedSetObj} selected={selectedTile} onPick={pickPiece} thumb={(p) => tileLib.compositeThumb(p.tiles)} buildMode={buildMode} onMode={applyBuildMode} />
      )}

      {/* Mobile build: floating undo/redo, top-left, out of the way of the camera compass (top-right). */}
      {isMobile && tab === 'build' && !drawerOpen && (
        <div style={{ position: 'fixed', left: 10, top: 'calc(env(safe-area-inset-top, 0px) + 10px)', zIndex: 65 }}>
          <HistoryButtons big canUndo={canUndo} canRedo={canRedo} onUndo={() => engineRef.current?.undo()} onRedo={() => engineRef.current?.redo()} />
        </div>
      )}

      {/* Mobile build: once a tile is picked the browser drawer collapses so the canvas is reachable.
          A slim floating bar keeps the selected tile, the mode chips (+ erase-layer stepper), and a way back. */}
      {isMobile && tab === 'build' && buildTab === '2d' && selectedTile && !drawerOpen && (
        <div style={{ position: 'fixed', left: 10, right: 10, bottom: 'calc(env(safe-area-inset-bottom, 0px) + 66px)', zIndex: 65, display: 'flex', flexDirection: 'column', background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 12, boxShadow: '0 8px 28px #000a', overflow: 'hidden' }}>
          {selectedSetObj && selectedSetObj.pieces.length > 1 && buildMode === 'place' && (
            <PiecePicker set={selectedSetObj} selected={selectedTile} onPick={pickPiece} thumb={(p) => tileLib.compositeThumb(p.tiles)} bordered={false} />
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 8, borderTop: selectedSetObj && selectedSetObj.pieces.length > 1 && buildMode === 'place' ? '1px solid var(--line)' : undefined }}>
            <div style={{ width: 40, height: 40, flexShrink: 0, borderRadius: 6, overflow: 'hidden', background: '#101014', border: '1px solid var(--line)' }}>
              {selPieceTiles ? <Thumb depKey={`grp:${selPieceTiles.map((t) => t.tile.name).join(',')}`} getUrl={() => tileLib.compositeThumb(selPieceTiles)} /> : <Thumb depKey={`tile:${selectedTile}`} getUrl={() => tileLib.thumbUrl(selectedTile)} />}
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flex: 1, overflowX: 'auto' }}>
              <BuildModeChips buildMode={buildMode} rectMode={rectMode} onMode={applyBuildMode} onRect={applyRectMode} showRect={isMobile} />
              {buildMode === 'erase' && <EraseDepthStepper depth={eraseDepth} onChange={applyEraseDepth} />}
            </div>
            <button className="secondary" onClick={() => engineRef.current?.clearTiles()} title="Remove every placed tile" style={{ flexShrink: 0, padding: '6px 10px', borderRadius: 6, border: '1px solid var(--line)' }}>Clear</button>
            <button className="secondary" onClick={() => setDrawerOpen(true)} style={{ flexShrink: 0, padding: '6px 12px', borderRadius: 6, border: '1px solid var(--accent)', background: 'var(--accent)', color: '#fff' }}>Tiles</button>
          </div>
        </div>
      )}

      {/* Mobile 3D-prop controls: one bottom sheet. Persistent on the 3D-props tab (Select mode reachable before
          anything is picked) and whenever a prop is selected on any tab. Keeps the scene live below it. */}
      {isMobile && !drawerOpen && (tab === 'build' ? buildTab === '3d' : !!selectedProp) && (() => {
        const sp = selectedProp;
        const multi = (sp?.count ?? 0) > 1;
        const slots = sp && !multi ? heldSlots.get(sp.name) : undefined;
        const cur = (slot: string) => sp?.attachments.find((a) => a.slot === slot)?.partName ?? null;
        const act = (o: { danger?: boolean; accent?: boolean } = {}): React.CSSProperties => ({ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, minHeight: 46, padding: '0 12px', fontSize: 13.5, fontWeight: 600, borderRadius: 12, cursor: 'pointer', border: `1px solid ${o.danger ? '#b23b30' : o.accent ? 'var(--accent)' : 'var(--line)'}`, background: o.accent ? 'var(--accent)' : '#16161d', color: o.danger ? '#ff7a6b' : o.accent ? '#fff' : 'var(--text)' });
        const pill = (on: boolean, disabled = false): React.CSSProperties => ({ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7, minHeight: 40, padding: '0 16px', fontSize: 13, fontWeight: 500, borderRadius: 999, cursor: disabled ? 'default' : 'pointer', border: `1px solid ${on ? 'var(--accent)' : 'var(--line)'}`, background: on ? 'var(--accent)' : '#16161d', color: on ? '#fff' : (disabled ? 'var(--muted)' : 'var(--text)'), opacity: disabled ? 0.45 : 1 });
        const dot = (on: boolean) => <span style={{ width: 13, height: 13, borderRadius: 999, flexShrink: 0, background: on ? '#fff' : 'transparent', border: `2px solid ${on ? '#fff' : 'var(--muted)'}` }} />;
        const secLabel: React.CSSProperties = { fontSize: 10, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--muted)', margin: '2px 0 7px' };
        const chip = (active: boolean): React.CSSProperties => ({ minHeight: 34, padding: '0 12px', fontSize: 12.5, borderRadius: 8, cursor: 'pointer', maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', border: `1px solid ${active ? 'var(--accent)' : 'var(--line)'}`, background: active ? 'var(--accent)' : '#16161d', color: active ? '#fff' : 'var(--text)' });
        return (
          <div style={{ position: 'fixed', left: 8, right: 8, bottom: 'calc(env(safe-area-inset-bottom, 0px) + 66px)', zIndex: 65, background: '#0d0d12f7', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)', border: '1px solid var(--line)', borderRadius: 18, boxShadow: '0 -8px 34px #000c', padding: '10px 12px 12px', maxHeight: '66vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 11 }}>
            <div style={{ alignSelf: 'center', width: 38, height: 4, borderRadius: 999, background: 'rgba(255,255,255,.18)', marginBottom: 1 }} />
            {sp ? (<>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ display: 'grid', placeItems: 'center', width: 30, height: 30, borderRadius: 8, background: '#5b8cff22', color: 'var(--accent)', flexShrink: 0 }}><BoxIcon size={17} /></span>
                <span style={{ flex: 1, minWidth: 0, fontSize: 14.5, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{multi ? `${sp.count} props selected` : sp.name}</span>
                <button className="secondary" onClick={() => { setPropMore(false); engineRef.current?.selectProp(null); }} style={{ ...act(), minHeight: 38, padding: '0 16px' }}>Done</button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
                <button className="secondary" onClick={() => engineRef.current?.duplicateSelectedProp()} style={act()}>Duplicate</button>
                <button className="secondary" onClick={() => engineRef.current?.resetSelectedProp()} style={act()}>Reset</button>
                <button className="secondary" onClick={() => engineRef.current?.deleteSelectedProp()} style={act({ danger: true })}>Delete</button>
              </div>
              <div>
                <div style={secLabel}>Attach</div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <button className="secondary" onClick={() => setPropSticky(!sp.sticky)} style={pill(sp.sticky)}>{dot(sp.sticky)}Sticky</button>
                  <button className="secondary" disabled={!sp.sticky} onClick={() => setPropAlign(!sp.align)} style={pill(sp.align, !sp.sticky)}>{dot(sp.align && sp.sticky)}Align</button>
                  {(multi || sp.attached) && <button className="secondary" onClick={detachProp} style={{ ...act(), minHeight: 40, padding: '0 16px' }}>{multi ? 'Detach all' : 'Detach'}</button>}
                </div>
                {!multi && sp.attached && <div style={{ marginTop: 7, fontSize: 12, color: 'var(--accent)', wordBreak: 'break-all', lineHeight: 1.35 }}>on {sp.attached}</div>}
                {!multi && !sp.attached && <div style={{ marginTop: 7, fontSize: 11.5, color: 'var(--muted)' }}>{sp.sticky ? 'Drag onto the character or another prop to stick it.' : 'Grounded (drag on the floor).'}</div>}
              </div>
              {!multi && (
                <button className="secondary" onClick={() => setPropMore((v) => !v)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, minHeight: 40, borderRadius: 10, border: '1px solid var(--line)', background: '#16161d', color: 'var(--text)', fontSize: 12.5, cursor: 'pointer' }}>
                  {propMore ? 'Hide' : 'Texture & attachments'} <ChevronIcon dir={propMore ? 'up' : 'down'} size={13} />
                </button>
              )}
              {!multi && propMore && (<>
                <div>
                  <div style={secLabel}>Texture</div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button className="secondary" onClick={() => applyPropTexXf({ ...sp.texXf, flipU: !sp.texXf.flipU })} style={pill(sp.texXf.flipU)}>{dot(sp.texXf.flipU)}Flip U</button>
                    <button className="secondary" onClick={() => applyPropTexXf({ ...sp.texXf, flipV: !sp.texXf.flipV })} style={pill(sp.texXf.flipV)}>{dot(sp.texXf.flipV)}Flip V</button>
                    <button className="secondary" onClick={() => applyPropTexXf({ ...sp.texXf, rot: (sp.texXf.rot + 90) % 360 })} style={{ ...act(), minHeight: 40, padding: '0 16px' }}>Rotate {sp.texXf.rot}&deg;</button>
                  </div>
                </div>
                {slots?.length ? (
                  <div>
                    <div style={secLabel}>Attachments</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {slots.map((s) => (
                        <div key={s.slot} style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
                          <span style={{ minWidth: 52, fontSize: 12, color: 'var(--muted)' }}>{s.slot}</span>
                          <button className="secondary" onClick={() => setPropAttach(s.slot, null)} style={chip(cur(s.slot) === null)}>None</button>
                          {s.options.map((o) => (<button key={o.partName} className="secondary" title={o.partName} onClick={() => setPropAttach(s.slot, o)} style={chip(cur(s.slot) === o.partName)}>{o.partName}</button>))}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </>)}
              <div style={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.4, borderTop: '1px solid var(--line)', paddingTop: 9 }}>
                {multi ? 'One finger drags the group. Two fingers twist to rotate, pinch to scale around the shared centre.' : 'One finger drags. Two fingers twist to rotate, pinch to scale.'}
              </div>
            </>) : (
              <div style={{ fontSize: 13, color: 'var(--text)', textAlign: 'center', padding: '4px 0 2px' }}>{selectMode ? 'Tap props to select, or drag a box around them.' : 'Tap a prop to select it.'}</div>
            )}
            <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
              <button className="secondary" onClick={() => toggleSelectMode(!selectMode)} title="Tap props to multi-select, or drag a box around them" style={{ ...act(selectMode ? { accent: true } : {}), flex: 1, minHeight: 42 }}>Select</button>
              <button className="secondary" onClick={() => toggleCamLock(!camLock)} title="Two fingers pan/zoom the camera instead of transforming the prop" style={{ ...act(camLock ? { accent: true } : {}), flex: 1, minHeight: 42 }}>{dot(camLock)}Cam lock</button>
              <button className="secondary" onClick={() => { setTab('build'); setBuildTab('3d'); setDrawerOpen(true); }} title="Browse props" style={{ ...act({ accent: true }), flex: 1.2, minHeight: 42 }}><BoxIcon size={15} />Browse</button>
            </div>
          </div>
        );
      })()}

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

// Build-tool mode chips (shared by the desktop panel toolbar and the mobile compact bar): Place/Erase
// (touch has no right-click) and a Rect toggle (touch has no shift). Desktop keeps its shortcuts too.
function BuildModeChips({ buildMode, rectMode, onMode, onRect, showRect }: {
  buildMode: 'place' | 'erase'; rectMode: boolean; onMode: (m: 'place' | 'erase') => void; onRect: (on: boolean) => void; showRect?: boolean;
}) {
  const chip = (on: boolean) => ({ padding: '6px 12px', borderRadius: 6, border: '1px solid var(--line)', background: on ? 'var(--accent)' : 'var(--panel)', color: on ? '#fff' : 'var(--text)', cursor: 'pointer' }) as const;
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
      <button className="secondary" onClick={() => onMode('place')} style={chip(buildMode === 'place')}>Place</button>
      <button className="secondary" onClick={() => onMode('erase')} style={chip(buildMode === 'erase')}>Erase</button>
      {/* desktop uses Shift-drag for rectangles, so the toggle is only offered on touch */}
      {showRect && <button className="secondary" onClick={() => onRect(!rectMode)} title="Rectangle fill: drag one corner to the opposite" style={chip(rectMode)}>Rect</button>}
    </div>
  );
}

// Undo / redo pair. `big` renders the touch-sized floating version for phones.
function HistoryButtons({ canUndo, canRedo, onUndo, onRedo, big }: {
  canUndo: boolean; canRedo: boolean; onUndo: () => void; onRedo: () => void; big?: boolean;
}) {
  const s = big ? 22 : 15, pad = big ? 10 : 6;
  const btn = (on: boolean) => ({ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: pad, borderRadius: 8, border: '1px solid var(--line)', background: 'var(--panel)', color: 'var(--text)', opacity: on ? 1 : 0.35, cursor: on ? 'pointer' : 'default' }) as const;
  const arrow = (redo: boolean) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {redo ? <><path d="M15 14l5-5-5-5" /><path d="M20 9H9a5 5 0 0 0 0 10h4" /></> : <><path d="M9 14 4 9l5-5" /><path d="M4 9h11a5 5 0 0 1 0 10H11" /></>}
    </svg>
  );
  return (
    <div style={{ display: 'flex', gap: 6 }}>
      <button className="secondary" disabled={!canUndo} onClick={onUndo} title="Undo (Ctrl+Z)" aria-label="Undo" style={btn(canUndo)}>{arrow(false)}</button>
      <button className="secondary" disabled={!canRedo} onClick={onRedo} title="Redo (Ctrl+Y)" aria-label="Redo" style={btn(canRedo)}>{arrow(true)}</button>
    </div>
  );
}

// Erase-depth stepper (phone, no hover): which stacked item to delete, counted from the top.
function EraseDepthStepper({ depth, onChange }: { depth: number; onChange: (d: number) => void }) {
  const btn = { padding: '6px 11px', borderRadius: 6, border: '1px solid var(--line)', background: 'var(--panel)', color: 'var(--text)', cursor: 'pointer', fontSize: 15, lineHeight: 1 } as const;
  return (
    <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexShrink: 0 }} title="Which stacked item to delete, from the top">
      <span style={{ fontSize: 11, color: 'var(--muted)' }}>layer</span>
      <button className="secondary" onClick={() => onChange(depth - 1)} style={btn}>-</button>
      <span style={{ fontSize: 12, minWidth: 38, textAlign: 'center', whiteSpace: 'nowrap' }}>{depth === 0 ? 'top' : `top-${depth}`}</span>
      <button className="secondary" onClick={() => onChange(depth + 1)} style={btn}>+</button>
    </div>
  );
}

// The pieces of the selected wall set (N/W walls, corner, pillar, window + door frames): pick which one
// to place while keeping the same material/colour. A horizontal strip of labelled thumbnails.
function PiecePicker({ set, selected, onPick, thumb, bordered = true, numbered = false, orientation = 'row' }: {
  set: TileSet; selected: string | null; onPick: (name: string) => void; thumb: (p: TilePiece) => Promise<string>; bordered?: boolean; numbered?: boolean; orientation?: 'row' | 'column';
}) {
  const col = orientation === 'column';
  return (
    <div style={{ padding: 8, borderTop: bordered ? '1px solid var(--line)' : undefined, display: 'flex', flexDirection: col ? 'column' : 'row', gap: 6, overflowX: col ? undefined : 'auto', overflowY: col ? 'auto' : undefined, alignItems: col ? 'center' : 'flex-end' }}>
      {set.pieces.map((p, i) => {
        const on = selected === p.tile.name;
        return (
          <button key={p.tile.name} className="secondary" onClick={() => onPick(p.tile.name)} title={numbered && i < 9 ? `${p.label} (${i + 1})` : p.label}
            style={{ position: 'relative', flexShrink: 0, width: 62, padding: 4, borderRadius: 6, border: `1px solid ${on ? 'var(--accent)' : 'var(--line)'}`, background: on ? '#5b8cff22' : '#14141a', display: 'flex', flexDirection: 'column', gap: 3, cursor: 'pointer' }}>
            <div style={{ width: '100%', height: 48, background: '#101014', borderRadius: 4, overflow: 'hidden' }}>
              <Thumb depKey={`grp:${p.tiles.map((t) => t.tile.name).join(',')}`} getUrl={() => thumb(p)} />
            </div>
            {numbered && i < 9 && <span style={{ position: 'absolute', top: 2, left: 2, fontSize: 9, fontWeight: 700, background: '#000a', color: '#fff', borderRadius: 3, padding: '0 4px', lineHeight: '14px' }}>{i + 1}</span>}
            <div style={{ fontSize: 9.5, textAlign: 'center', color: on ? 'var(--text)' : 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.label}</div>
          </button>
        );
      })}
    </div>
  );
}

// Desktop place-mode hotbar: the open set's pieces as a draggable bar floating over the canvas, numbered
// to match the 1-9 shortcuts. Its position is remembered; default is bottom-centre.
function BuildHotbar({ set, selected, onPick, thumb, buildMode, onMode }: {
  set: TileSet; selected: string | null; onPick: (name: string) => void; thumb: (p: TilePiece) => Promise<string>;
  buildMode: 'place' | 'erase'; onMode: (m: 'place' | 'erase') => void;
}) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(() => { try { return JSON.parse(localStorage.getItem('pz-hotbar-pos') || 'null'); } catch { return null; } });
  const [dragging, setDragging] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [open, setOpen] = useState(false); // settings popout
  const grab = useRef<{ dx: number; dy: number } | null>(null);
  useEffect(() => { if (pos) try { localStorage.setItem('pz-hotbar-pos', JSON.stringify(pos)); } catch { /* ignore */ } }, [pos]);
  const onDown = (e: React.PointerEvent) => {
    const box = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
    grab.current = { dx: e.clientX - box.left, dy: e.clientY - box.top }; setDragging(true);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    if (!grab.current) return;
    setPos({ x: Math.max(4, Math.min(window.innerWidth - 90, e.clientX - grab.current.dx)), y: Math.max(4, Math.min(window.innerHeight - 40, e.clientY - grab.current.dy)) });
  };
  const onUp = () => { grab.current = null; setDragging(false); };
  const [cfg, setCfg] = useState<{ autoFade: boolean; vertical: boolean }>(() => { try { return { autoFade: false, vertical: false, ...JSON.parse(localStorage.getItem('pz-hotbar-cfg') || '{}') }; } catch { return { autoFade: false, vertical: false }; } });
  useEffect(() => { try { localStorage.setItem('pz-hotbar-cfg', JSON.stringify(cfg)); } catch { /* ignore */ } }, [cfg]);
  const vert = cfg.vertical;
  const place: React.CSSProperties = pos ? { left: pos.x, top: pos.y } : (vert ? { left: 16, top: '50%', transform: 'translateY(-50%)' } : { left: '50%', bottom: 22, transform: 'translateX(-50%)' });
  const faded = cfg.autoFade && !hovered && !dragging && !open;
  const trailing = vert ? { borderBottom: '1px solid var(--line)' } : { borderRight: '1px solid var(--line)' };
  const modeBtn = (on: boolean, last = false) => ({ display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1, padding: '5px 8px', border: 'none', ...(last ? {} : (vert ? { borderRight: '1px solid var(--line)' } : { borderBottom: '1px solid var(--line)' })), background: on ? 'var(--accent)' : 'transparent', color: on ? '#fff' : 'var(--muted)', cursor: 'pointer' }) as const;
  const toggle = (label: string, val: boolean, set: () => void) => (
    <button onClick={set} style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 9, padding: '7px 6px', background: 'transparent', border: 'none', color: 'var(--text)', cursor: 'pointer', fontSize: 12.5, textAlign: 'left' }}>
      <span style={{ width: 16, height: 16, flexShrink: 0, borderRadius: 4, border: `1px solid ${val ? 'var(--accent)' : 'var(--line)'}`, background: val ? 'var(--accent)' : 'transparent', display: 'grid', placeItems: 'center', color: '#fff' }}>{val && <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>}</span>
      {label}
    </button>
  );
  return (
    <div onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}
      style={{ position: 'fixed', zIndex: 60, maxWidth: vert ? undefined : 'calc(100vw - 16px)', maxHeight: vert ? 'calc(100vh - 16px)' : undefined, display: 'flex', flexDirection: vert ? 'column' : 'row', alignItems: 'stretch', background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 10, boxShadow: '0 8px 28px #000a', opacity: faded ? 0.25 : 1, transition: 'opacity .18s ease', ...place }}>
      <div onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} title="Drag to move"
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: vert ? '5px 0' : '0 7px', cursor: 'grab', color: 'var(--muted)', touchAction: 'none', ...trailing }}>
        <svg width={vert ? 18 : 8} height={vert ? 8 : 18} viewBox={vert ? '0 0 18 8' : '0 0 8 18'} fill="currentColor" aria-hidden="true">{vert ? <><circle cx="3" cy="2" r="1.3" /><circle cx="3" cy="6" r="1.3" /><circle cx="9" cy="2" r="1.3" /><circle cx="9" cy="6" r="1.3" /><circle cx="15" cy="2" r="1.3" /><circle cx="15" cy="6" r="1.3" /></> : <><circle cx="2" cy="3" r="1.3" /><circle cx="6" cy="3" r="1.3" /><circle cx="2" cy="9" r="1.3" /><circle cx="6" cy="9" r="1.3" /><circle cx="2" cy="15" r="1.3" /><circle cx="6" cy="15" r="1.3" /></>}</svg>
      </div>
      {/* Place / Erase / settings, perpendicular to the bar, at the left (or top) of the first piece */}
      <div style={{ display: 'flex', flexDirection: vert ? 'row' : 'column', ...trailing }}>
        <button onClick={() => onMode('place')} title="Place (E)" aria-label="Place" style={modeBtn(buildMode === 'place')}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9.06 11.9l8.07-8.06a2.85 2.85 0 1 1 4.03 4.03l-8.06 8.08" /><path d="M7.07 14.94c-1.66 0-3 1.35-3 3.02 0 1.33-2.5 1.52-2 2.02 1.08 1.1 2.49 2.02 4 2.02 2.2 0 4-1.8 4-4.04a3.01 3.01 0 0 0-3-3.02z" /></svg>
        </button>
        <button onClick={() => onMode('erase')} title="Erase (E)" aria-label="Erase" style={modeBtn(buildMode === 'erase')}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21" /><path d="M22 21H7" /><path d="m5 11 9 9" /></svg>
        </button>
        <button onClick={() => setOpen((o) => !o)} title="Hotbar settings" aria-label="Hotbar settings" style={modeBtn(open, true)}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
        </button>
      </div>
      <div style={{ display: 'flex', minHeight: 0, minWidth: 0, opacity: buildMode === 'erase' ? 0.5 : 1 }}>
        <PiecePicker set={set} selected={selected} onPick={onPick} thumb={thumb} bordered={false} numbered orientation={vert ? 'column' : 'row'} />
      </div>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 59 }} />
          <div style={{ position: 'absolute', zIndex: 61, ...(vert ? { left: '100%', top: 0, marginLeft: 8 } : { bottom: '100%', left: 0, marginBottom: 8 }), width: 210, background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 8, boxShadow: '0 8px 28px #000a', padding: 6 }}>
            <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.05em', padding: '2px 6px 4px' }}>Hotbar</div>
            {toggle('Auto-fade when idle', cfg.autoFade, () => setCfg((c) => ({ ...c, autoFade: !c.autoFade })))}
            {toggle('Vertical bar', cfg.vertical, () => setCfg((c) => ({ ...c, vertical: !c.vertical })))}
          </div>
        </>
      )}
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
  exp: ExportOpts; setExp: (u: (e: ExportOpts) => ExportOpts) => void;
  devMode: boolean; onExportCharacterData: () => void;
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
  const slider = (k: keyof Light, name: string, min: number, max: number) => {
    const atDefault = Math.abs(light[k] - LIGHT_DEFAULT[k]) < 1e-6;
    return (
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 5 }}>
        <span style={{ width: 62, fontSize: 12, color: 'var(--muted)' }}>{name}</span>
        <input type="range" min={min} max={max} step={0.01} value={light[k]} onChange={(e) => setL(k, Number(e.target.value))} style={{ flex: 1, accentColor: '#5b8cff' }} />
        <span style={{ width: 34, fontSize: 11, textAlign: 'right', fontFamily: 'monospace', color: 'var(--muted)' }}>{light[k].toFixed(2)}</span>
        <button className="secondary" onClick={() => setL(k, LIGHT_DEFAULT[k])} disabled={atDefault}
          title={`Reset ${name} to ${LIGHT_DEFAULT[k]}`} aria-label={`Reset ${name}`}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 3, opacity: atDefault ? 0.3 : 1, cursor: atDefault ? 'default' : 'pointer' }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v4h4" />
          </svg>
        </button>
      </div>
    );
  };
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
  const [advanced, setAdvanced] = useState(false);
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
      <button className="secondary" onClick={() => setAdvanced((a) => !a)} style={{ marginTop: 8, padding: '5px 10px', fontSize: 11.5, display: 'inline-flex', alignItems: 'center', gap: 6, borderRadius: 6 }}>
        <span style={{ fontSize: 8, display: 'inline-block', width: 9, transform: advanced ? 'none' : 'rotate(-90deg)', transition: 'transform .12s' }}>▼</span>
        Advanced export options
      </button>
      {advanced && (() => {
        const e = s.exp; const setE = (patch: Partial<ExportOpts>) => s.setExp((o) => ({ ...o, ...patch }));
        const sel = { background: '#14141a', color: 'var(--text)', border: '1px solid var(--line)', borderRadius: 6, padding: '5px 7px', fontSize: 12 } as const;
        const hdr = { fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--muted)', margin: '10px 0 2px' } as const;
        const row = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 5 } as const;
        const lab = { fontSize: 11.5, color: 'var(--text)' } as const;
        const resOpts = (vals: number[]) => vals.map((v) => <option key={v} value={v}>{v}p</option>);
        return (
          <div style={{ border: '1px solid var(--line)', borderRadius: 8, padding: '2px 12px 12px', marginTop: 8 }}>
            <div style={hdr}>PNG (still)</div>
            <div style={row}><span style={lab}>Resolution</span><select value={e.pngRes} onChange={(ev) => setE({ pngRes: Number(ev.target.value) })} style={sel}>{resOpts([720, 1080, 1440, 2160, 2880, 4320])}</select></div>

            <div style={hdr}>GIF</div>
            <div style={row}><span style={lab}>Resolution</span><select value={e.gifRes} onChange={(ev) => setE({ gifRes: Number(ev.target.value) })} style={sel}>{resOpts([256, 360, 512, 720])}</select></div>
            <div style={row}><span style={lab}>Colours</span><select value={e.gifColors} onChange={(ev) => setE({ gifColors: Number(ev.target.value) })} style={sel}>{[32, 64, 128, 256].map((v) => <option key={v} value={v}>{v}</option>)}</select></div>
            <div style={row}><span style={lab}>Frame rate</span><select value={e.gifFps} onChange={(ev) => setE({ gifFps: Number(ev.target.value) })} style={sel}>{[10, 12, 15, 20, 24, 30].map((v) => <option key={v} value={v}>{v} fps</option>)}</select></div>

            <div style={hdr}>MP4 / video</div>
            <div style={row}><span style={lab}>Resolution</span><select value={e.mp4Res} onChange={(ev) => setE({ mp4Res: Number(ev.target.value) })} style={sel}>{resOpts([480, 720, 1080, 1440, 2160])}</select></div>
            <div style={row}><span style={lab}>Frame rate</span><select value={e.mp4Fps} onChange={(ev) => setE({ mp4Fps: Number(ev.target.value) })} style={sel}>{[24, 30, 60].map((v) => <option key={v} value={v}>{v} fps</option>)}</select></div>
            <div style={row}><span style={lab}>Codec</span><select value={e.mp4Codec} onChange={(ev) => setE({ mp4Codec: ev.target.value as VideoCodec })} style={sel}>
              {(['auto', 'h264', 'h265', 'vp9'] as VideoCodec[]).map((c) => { const ok = codecSupported(c); const nm = { auto: 'Auto (best available)', h264: 'H.264 / AVC', h265: 'H.265 / HEVC', vp9: 'VP9 (WebM)' }[c]; return <option key={c} value={c} disabled={!ok}>{nm}{ok ? '' : ' - unsupported'}</option>; })}
            </select></div>
            <div style={row}><span style={lab}>Quality</span><select value={e.mp4Quality} onChange={(ev) => setE({ mp4Quality: ev.target.value as VideoQuality })} style={sel}>{(['low', 'medium', 'high'] as VideoQuality[]).map((q) => <option key={q} value={q}>{q[0].toUpperCase() + q.slice(1)}</option>)}</select></div>
            <div style={{ color: 'var(--muted)', fontSize: 10.5, marginTop: 8, lineHeight: 1.5 }}>Codec support depends on your browser (H.265 recording is rarely available); an unavailable pick falls back automatically. Higher resolution, frame rate, quality or colours means larger files and slower exports.</div>
          </div>
        );
      })()}
      <div style={{ color: 'var(--muted)', fontSize: 11, marginTop: 6 }}>
        GIF “Clip loop” captures one full loop of the current animation at your chosen playback speed, for seamless loops. Transparent background applies to PNG + GIF; video always uses the chosen colour. Everything is generated in your browser and saved straight to your device.
      </div>

      {s.devMode && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px dashed var(--line)' }}>
          <label style={{ ...label, marginTop: 0, color: '#ffd23f' }}>Developer</label>
          <button className="secondary" onClick={s.onExportCharacterData} title="Download a formatted JSON of the whole current character + scene (equipped items, meshes, textures, sources, hair/beard/body, animation)" style={{ padding: '7px 12px' }}>Export character data (JSON)</button>
          <div style={{ color: 'var(--muted)', fontSize: 11, marginTop: 6 }}>A readable snapshot of every equipped item and its mesh / texture / mod source, plus body, hair, beard, animation and scene. Toggle this section under Settings, Developer mode.</div>
        </div>
      )}

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
function CharacterTab({ hairData, gender, setGender, skin, tones, zombieSkins, skinThumbUrl, bodyOptions, bodySel, onBody, uvVerdict, textureOptions, textureSel, onTexture, onSkin, thumbs, hairSel, beardSel, hairColor, beardColor, matchBeard, onToggleMatchBeard, onPickPart, onRecolour, favs, onToggleFav, onImport, onNew, savedCount, onOpenSaved, dressShown, dressWorn, onToggleDress }: {
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
  dressShown: boolean;
  dressWorn: boolean;
  onToggleDress: (on: boolean) => void;
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
        <label style={{ display: 'flex', alignItems: 'center', gap: 7, margin: '0 0 12px', fontSize: 12.5, color: dressShown ? 'var(--text)' : 'var(--muted)', cursor: dressWorn ? 'default' : 'pointer' }}
          title={dressWorn ? 'A skirt or dress is worn, so its bones and mesh show automatically.' : 'Show the skirt/dress bones and their base mesh. Off by default - the hidden skirt mesh otherwise blocks placing props between the legs.'}>
          <input type="checkbox" checked={dressShown} disabled={dressWorn} onChange={(e) => onToggleDress(e.target.checked)} style={{ accentColor: 'var(--accent)' }} />
          Show dress / skirt bones + mesh
          {dressWorn && <span style={{ fontSize: 10.5, color: 'var(--muted)' }}>(auto: dress worn)</span>}
        </label>
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

// Modal: browse saved animation poses as a thumbnail gallery; save the current, load or delete.
function PosesModal({ poses, currentClip, clips, preview, onClose, onSave, onLoad, onDelete }: {
  poses: Record<string, PoseData>; currentClip: string | null;
  clips: { id: string; rel: string; format: string; name: string }[]; preview: ClipPreview;
  onClose: () => void;
  onSave: (name: string) => void; onLoad: (name: string) => void; onDelete: (name: string) => void;
}) {
  const [name, setName] = useState('');
  const [q, setQ] = useState('');
  // Resolve a saved pose to a playable clip (+ its bone-delta edit) so its thumbnail can auto-play the edited motion on hover.
  const resolvePreview = (d: PoseData): { clip: { id: string; rel: string; format: string }; edit: PreviewEdit | null } | null => {
    let clip: { id: string; rel: string; format: string } | null = d.rel && d.format ? { id: d.id ?? d.rel, rel: d.rel, format: d.format } : null;
    if (!clip) { const m = clips.find((c) => c.name === d.clip || c.rel === d.clip); if (m) clip = { id: m.id, rel: m.rel, format: m.format }; }
    if (!clip) return null;
    const bones = d.bones || {};
    const ticks = Object.values(bones).flat().map((k) => k.tick);
    const lo = d.lo ?? (ticks.length ? Math.min(...ticks) : 0), hi = d.hi ?? (ticks.length ? Math.max(...ticks) : 1);
    const edit = Object.keys(bones).length ? { bones, lo, hi: hi > lo ? hi : lo + 1 } : null;
    return { clip, edit };
  };
  const list = Object.entries(poses).sort((a, b) => (b[1].saved || 0) - (a[1].saved || 0))
    .filter(([n, d]) => { const s = q.trim().toLowerCase(); return !s || n.toLowerCase().includes(s) || (d.clip || '').toLowerCase().includes(s); });
  const input = { background: '#14141a', color: 'var(--text)', border: '1px solid var(--line)', borderRadius: 6, padding: '8px 10px', fontSize: 13 } as const;
  return (
    <div style={{ position: 'fixed', inset: 0, background: '#000000aa', zIndex: 400, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 680, maxWidth: '92vw', maxHeight: '84vh', background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 10, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--line)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontWeight: 600 }}>Saved poses{Object.keys(poses).length ? ` (${Object.keys(poses).length})` : ''}</span>
          <span role="button" onClick={onClose} title="close" style={{ cursor: 'pointer', color: 'var(--muted)' }}>✕</span>
        </div>
        <div style={{ padding: '12px 14px', display: 'flex', gap: 8, borderBottom: '1px solid var(--line)', flexWrap: 'wrap' }}>
          <input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) { onSave(name.trim()); setName(''); } }} placeholder="Name the current pose..." style={{ ...input, flex: 1, minWidth: 160 }} />
          <button disabled={!name.trim()} onClick={() => { onSave(name.trim()); setName(''); }} style={{ padding: '8px 16px' }}>Save current</button>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search..." style={{ ...input, width: 160 }} />
        </div>
        <div style={{ padding: 14, overflow: 'auto' }}>
          {!list.length
            ? <div style={{ color: 'var(--muted)', fontSize: 13, textAlign: 'center', padding: '44px 12px', lineHeight: 1.6 }}>{Object.keys(poses).length ? 'No poses match your search.' : <>No saved poses yet.<br />Edit an animation, name it above and hit <b>Save current</b> (or Ctrl+S). A snapshot is stored with each.</>}</div>
            : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(128px, 1fr))', gap: 12 }}>
                {list.map(([n, d]) => (
                  <div key={n} style={{ display: 'flex', flexDirection: 'column', border: `1px solid ${d.clip && d.clip === currentClip ? 'var(--accent)' : 'var(--line)'}`, borderRadius: 8, overflow: 'hidden', background: '#0e0e12' }}>
                    <button onClick={() => { onLoad(n); onClose(); }} title={`Load ${n}`}
                      onMouseEnter={(e) => { const p = resolvePreview(d); if (!p) return; const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); preview.play(p.clip, { left: r.left, top: r.top, width: r.width, height: r.height }, p.edit); }}
                      onMouseLeave={() => preview.stop()}
                      style={{ position: 'relative', padding: 0, border: 'none', cursor: 'pointer', aspectRatio: '0.76', background: '#1b1d24', display: 'grid', placeItems: 'center', overflow: 'hidden' }}>
                      {d.thumb ? <img src={d.thumb} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <span style={{ color: 'var(--muted)', fontSize: 24 }}>&#9672;</span>}
                    </button>
                    <div style={{ padding: '5px 7px', display: 'flex', alignItems: 'center', gap: 6 }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 11.5, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={n}>{n}</div>
                        <div style={{ fontSize: 9.5, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={d.clip || ''}>{(d.clip || '').replace(/^Bob_/, '') || 'pose'}</div>
                      </div>
                      <button className="secondary" onClick={() => onDelete(n)} title="delete" style={{ flexShrink: 0, padding: '2px 6px', fontSize: 11, borderRadius: 5, border: '1px solid var(--line)', color: 'var(--muted)' }}>✕</button>
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
