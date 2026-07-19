import { useEffect, useMemo, useRef, useState } from 'react';
import { listClips, listClothing, listHeldItems, listHair, clothingGroup, CLOTHING_GROUP_ORDER, HELD_GROUP_ORDER, SKIN_TONES } from '@shared/character-core.js';
import { CharacterEngine, type Ctx } from './render/character-engine';
import { ThumbnailProvider } from './render/thumbnail-provider';
import { ClipPreview } from './render/clip-preview';
import { FloorLibrary } from './render/floor';
import { AssetGrid, type GridItem } from './AssetGrid';
import { Thumb } from './Thumb';
import { exportPng, exportGif, exportVideo, download, type BgConfig, type Content } from './render/export-media';
import { discoverSaves, importCharacter, type SaveEntry, type ParsedChar } from './save/save-import';

const rgb01 = (rgb: number[]) => [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255];
const rgbHex = (rgb: number[]) => '#' + rgb.map((c) => Math.max(0, Math.min(255, c)).toString(16).padStart(2, '0')).join('');

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

type Tab = 'animate' | 'clothing' | 'held' | 'character' | 'scene' | 'floor';
type FavKind = 'clothing' | 'held' | 'hair' | 'beard';
const favKey = (kind: FavKind, name: string) => `${kind}:${name}`;
const floorCategory = (name: string) => name.replace(/(_\d+)+$/, '').replace(/^(floors_|blends_)/, '');
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
interface HairStyle { name: string; model?: string; texture?: string }
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

export function CharacterViewer({ ctx, index }: { ctx: Ctx; index: unknown }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<CharacterEngine | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const startedRef = useRef(false);
  const pendingImportRef = useRef<ParsedChar | null>(null);
  const applyLookRef = useRef<((p: ParsedChar) => Promise<void>) | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [gender, setGender] = useState<'male' | 'female'>('male');
  const [skin, setSkin] = useState<string>((SKIN_TONES as Record<string, string[]>).male[0]);
  const tones = (SKIN_TONES as Record<string, string[]>)[gender];
  const [status, setStatus] = useState('loading body…');
  const [nowPlaying, setNowPlaying] = useState('');
  const [playing, setPlaying] = useState(true);
  const [tab, setTab] = useState<Tab>('character');
  const [equipTick, setEquipTick] = useState(0);
  const [, setBusy] = useState('');
  const [panelW, setPanelW] = useState(() => Number(localStorage.getItem('pz-panel-w')) || 420);
  const [clothOnBody, setClothOnBody] = useState(true);
  const [favs, setFavs] = useState<Set<string>>(() => { try { return new Set(JSON.parse(localStorage.getItem('pz-favorites') || '[]') as string[]); } catch { return new Set(); } });
  useEffect(() => { localStorage.setItem('pz-favorites', JSON.stringify([...favs])); }, [favs]);
  const toggleFav = (kind: FavKind, name: string) => setFavs((s) => { const n = new Set(s); const k = favKey(kind, name); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  // hair/beard selection lifted here so the Character tab and the Favorites tab agree on it
  const [hairSel, setHairSel] = useState('None');
  const [beardSel, setBeardSel] = useState('None');
  const [hairColor, setHairColor] = useState('#5a3a20');
  const [beardColor, setBeardColor] = useState('#5a3a20');
  const [equipOpen, setEquipOpen] = useState(false);
  // studio / export
  const [camPreset, setCamPreset] = useState<CamPreset>('orbit');
  const [studioAspect, setStudioAspect] = useState<number | null>(null);
  const [bg, setBg] = useState<BgConfig>({ mode: 'solid', color1: '#20242c', color2: '#0a0b10', angle: 90 });
  const [turntable, setTurntable] = useState(false);
  const [gifMode, setGifMode] = useState<'clip' | 'fixed'>('clip');
  const [mp4Seconds, setMp4Seconds] = useState(10);
  const [viewfinder, setViewfinder] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const [exporting, setExporting] = useState<{ label: string; progress: number } | null>(null);
  const [loop, setLoop] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [camMode, setCamMode] = useState<'orbit' | 'iso'>('orbit');
  const [facing, setFacing] = useState<number | null>(0);
  const scrubRef = useRef<HTMLInputElement>(null);
  const scrubbingRef = useRef(false);

  const clips: Clip[] = useMemo(() => listClips(index), [index]);
  const clipItems = useMemo(() => clips.map((c) => ({ ...c, key: c.id, label: c.name, facet: clipCategory(c.name), source: c.modName || 'Vanilla' })), [clips]);
  const [currentClipId, setCurrentClipId] = useState<string | null>(null);
  const clothing = useMemo(() => (listClothing(index) as Array<{ name: string; kind: string; location: string; isMod: boolean; modName?: string | null }>)
    .map((c) => ({ ...c, key: c.name, label: c.name, facet: clothingGroup(c), source: c.modName || 'Vanilla' })), [index]);
  const held = useMemo(() => (listHeldItems(index) as Array<{ name: string; isMod?: boolean; modName?: string | null; group: string; tags: string[] }>)
    .map((h) => ({ ...h, key: h.name, label: h.name, facet: h.group, isMod: !!h.isMod, source: h.modName || 'Vanilla' })), [index]);
  const hairData = useMemo(() => listHair(index) as HairData, [index]);

  const idleClip = useMemo(() =>
    clips.find((c) => c.name === 'Bob_Idle') || clips.find((c) => /^bob_idle\b/i.test(c.name)) || clips.find((c) => c.actor.toLowerCase() === 'bob' && /idle/i.test(c.name)),
    [clips]);
  const thumbs = useMemo(() => new ThumbnailProvider(ctx, idleClip), [ctx, idleClip]);
  useEffect(() => () => thumbs.dispose(), [thumbs]);
  const preview = useMemo(() => new ClipPreview(ctx), [ctx]);
  useEffect(() => () => preview.dispose(), [preview]);
  const floorLib = useMemo(() => new FloorLibrary(ctx.resolver as ConstructorParameters<typeof FloorLibrary>[0]), [ctx]);
  const [floorTiles, setFloorTiles] = useState<{ name: string }[]>([]);
  const [floorSel, setFloorSel] = useState<string | null>(null);
  const floorItems = useMemo(() => floorTiles.map((t) => ({ ...t, key: t.name, label: t.name.replace(/^(floors_|blends_)/, ''), facet: floorCategory(t.name), isMod: false, source: 'Vanilla' })), [floorTiles]);
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
  useEffect(() => { if (tab === 'floor' && !floorTiles.length) floorLib.list().then((ts) => setFloorTiles(ts as { name: string }[])).catch(() => {}); }, [tab, floorLib, floorTiles.length]);
  // scrolling detaches the fixed-position hover preview from its cell - hide it
  useEffect(() => { const off = () => preview.stop(); window.addEventListener('wheel', off, { passive: true }); return () => window.removeEventListener('wheel', off); }, [preview]);
  useEffect(() => { localStorage.setItem('pz-panel-w', String(panelW)); }, [panelW]);


  // engine once; refit the canvas whenever its container resizes (window OR splitter drag)
  useEffect(() => {
    const eng = new CharacterEngine(canvasRef.current!, ctx);
    eng.onClipName = setNowPlaying;
    eng.onFrame = (t, dur) => { const el = scrubRef.current; if (el && !scrubbingRef.current) el.value = String(dur ? ((t % dur) / dur) * 1000 : 0); };
    eng.onCamMode = setCamMode; // keep the Scene-tab toggle in sync with auto-switches
    eng.onViewfinder = setViewfinder; // studio letterbox rect (CSS px)
    engineRef.current = eng;
    const ro = new ResizeObserver(() => eng.fit());
    if (canvasRef.current?.parentElement) ro.observe(canvasRef.current.parentElement);
    return () => { ro.disconnect(); eng.dispose(); engineRef.current = null; };
  }, [ctx]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const eng = engineRef.current; if (!eng) return;
      setStatus('loading body…');
      try {
        await eng.loadBody(gender);
        if (cancelled) return;
        setStatus(''); setEquipTick((t) => t + 1);
        if (pendingImportRef.current) { const p = pendingImportRef.current; pendingImportRef.current = null; await applyLookRef.current?.(p); }
        else setSkin((SKIN_TONES as Record<string, string[]>)[gender][0]); // gender load resets to the default tone
        if (!startedRef.current && idleClip) {
          startedRef.current = true;
          try { await eng.playClip(idleClip); setPlaying(true); } catch { /* non-fatal */ }
        }
      } catch (e) { if (!cancelled) setStatus('body error: ' + (e instanceof Error ? e.message : String(e))); }
    })();
    return () => { cancelled = true; };
  }, [gender, idleClip]);

  async function guard(fn: () => Promise<unknown>) {
    try { await fn(); } catch (e) { setNowPlaying('error: ' + (e instanceof Error ? e.message : String(e))); }
    finally { setBusy(''); setEquipTick((t) => t + 1); }
  }
  const playClip = (c: Clip) => guard(async () => { await engineRef.current!.playClip(c); setPlaying(true); setCurrentClipId(c.id); });
  const toggleCloth = (it: { name: string }) => guard(() => engineRef.current!.toggleClothing(it));
  const toggleHeld = (it: { name: string }) => guard(() => engineRef.current!.toggleHeld(it));
  const togglePlay = () => { const e = engineRef.current; if (e) setPlaying(e.togglePlay()); };
  // hair/beard apply + recolour (shared by the Character and Favorites tabs)
  const applyHairPart = (kind: 'hair' | 'beard', style: HairStyle) => {
    (kind === 'hair' ? setHairSel : setBeardSel)(style.name);
    engineRef.current?.applyPart(kind, { name: style.name, model: style.model, texture: style.texture }, hexRgb(kind === 'hair' ? hairColor : beardColor)).catch(() => {});
  };
  const recolourPart = (kind: 'hair' | 'beard', hex: string) => {
    (kind === 'hair' ? setHairColor : setBeardColor)(hex);
    engineRef.current?.setPartTint(kind, hexRgb(hex));
  };
  // equipped-panel actions
  const toggleHide = (name: string, hidden: boolean) => guard(() => engineRef.current!.setItemHidden(name, hidden));
  const removeEquip = (name: string, type: 'clothing' | 'held') => guard(() => engineRef.current!.removeEquipped(name, type));

  // studio: push camera preset / aspect / turntable into the engine (aspect first so presets reframe)
  useEffect(() => { const e = engineRef.current; if (!e) return; e.setExportAspect(studioAspect); e.applyCameraPreset(camPreset); }, [studioAspect]);
  useEffect(() => { engineRef.current?.applyCameraPreset(camPreset); }, [camPreset]);
  useEffect(() => { engineRef.current?.setTurntable(turntable); }, [turntable]);

  const runExport = async (kind: 'png' | 'gif' | 'mp4') => {
    const eng = engineRef.current; if (!eng || exporting) return;
    const aspect = studioAspect ?? eng.getCurrentAspect();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const content: Content = turntable ? 'turntable' : 'anim';
    try {
      if (kind === 'png') {
        setExporting({ label: 'PNG', progress: 1 });
        const [w, h] = evenDims(aspect, 1080);
        download(await exportPng(eng, w, h, bg), `pz-character-${stamp}.png`);
      } else if (kind === 'gif') {
        setExporting({ label: 'GIF', progress: 0 });
        const [w, h] = evenDims(aspect, 512);
        const blob = await exportGif(eng, w, h, bg, { mode: gifMode, seconds: 5, fps: gifMode === 'clip' ? 24 : 15, speed, content, onProgress: (p) => setExporting({ label: 'GIF', progress: p }) });
        download(blob, `pz-character-${stamp}.gif`);
      } else {
        setExporting({ label: 'video', progress: 0 });
        const [w, h] = evenDims(aspect, 1080);
        const { blob, ext } = await exportVideo(eng, w, h, bg, { seconds: mp4Seconds, fps: 30, content, onProgress: (p) => setExporting({ label: 'video', progress: p }) });
        download(blob, `pz-character-${stamp}.${ext}`);
      }
    } catch (e) { setNowPlaying('export error: ' + (e instanceof Error ? e.message : String(e))); }
    finally { setExporting(null); }
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
    if (p.hair) {
      const hs = findHairStyle(p.hair.model, g);
      setHairSel(hs?.name || 'None');
      if (p.hair.color) setHairColor(rgbHex(p.hair.color));
      eng.applyPart('hair', hs || { name: 'None' }, p.hair.color ? rgb01(p.hair.color) : null).catch(() => {});
    }
    if (p.beard && p.beard.model) {
      const bs = findBeardStyle(p.beard.model);
      setBeardSel(bs?.name || 'None');
      if (p.beard.color) setBeardColor(rgbHex(p.beard.color));
      eng.applyPart('beard', bs || { name: 'None' }, p.beard.color ? rgb01(p.beard.color) : null).catch(() => {});
    } else { setBeardSel('None'); eng.applyPart('beard', { name: 'None' }, null).catch(() => {}); }
    await eng.clearAllClothing();
    let worn = 0;
    for (const c of p.clothing || []) {
      const item = findClothingItem(c);
      if (item) { try { await eng.toggleClothing(item, c.tint ? rgb01(c.tint) : null); worn++; } catch { /* skip */ } }
    }
    setEquipTick((t) => t + 1);
    setNowPlaying(`imported: ${worn}/${p.clothing?.length || 0} clothing` + (p.warnings.length ? '. ' + p.warnings.join('; ') : ''));
  };
  applyLookRef.current = applyLook;

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

  const tabs: [Tab, string][] = [['character', 'Character'], ['clothing', 'Clothing'], ['held', 'Held'], ['animate', 'Animate'], ['floor', 'Floor'], ['scene', 'Scene']];
  const segBtn = (on: boolean) => ({ borderRadius: 0, padding: '6px 9px', background: on ? 'var(--accent)' : 'var(--panel)', color: on ? '#fff' : 'var(--muted)' }) as const;
  void equipTick; // re-read equipped state on every equip change
  const equipList = engineRef.current?.equippedList() ?? [];

  return (
    <div ref={containerRef} style={{ display: 'flex', height: 'calc(100vh - 128px)', minHeight: 460 }}>
      {importOpen && <ImportModal onClose={() => setImportOpen(false)} onImport={applyImport} />}
      <div style={{ flex: 1, minWidth: 320, position: 'relative', background: '#14141a', border: '1px solid var(--line)', borderRadius: 8, overflow: 'hidden' }}>
        {/* studio layer: background sits behind the (transparent) WebGL canvas, clipped to the
            viewfinder rect so outside the frame stays the neutral letterbox */}
        <div style={{ position: 'absolute', inset: 0 }}>
          {viewfinder && <div style={{ position: 'absolute', left: viewfinder.left, top: viewfinder.top, width: viewfinder.width, height: viewfinder.height, outline: '1px solid #ffffff2a', ...bgStyle(bg) }} />}
          <canvas ref={canvasRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }} />
        </div>
        {exporting && (
          <div style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%,-50%)', background: '#000000cc', color: '#fff', padding: '10px 16px', borderRadius: 8, fontSize: 13, zIndex: 5, textAlign: 'center' }}>
            Exporting {exporting.label}… {Math.round(exporting.progress * 100)}%
            {exporting.label === 'video' && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 3 }}>recording in real time</div>}
          </div>
        )}
        <div style={{ position: 'absolute', left: 12, top: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
          {status && <span style={{ color: 'var(--muted)', background: '#00000099', padding: '4px 8px', borderRadius: 6 }}>{status}</span>}
          <span style={{ color: 'var(--muted)', background: '#00000099', padding: '4px 8px', borderRadius: 6, maxWidth: 340, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{nowPlaying || 'pick a clip →'}</span>
          {idleClip && <button className="secondary" title="Reset to idle animation" onClick={() => playClip(idleClip)} style={{ padding: '4px 10px', fontSize: 12, lineHeight: 1 }}>↺ Idle</button>}
        </div>
        <div style={{ position: 'absolute', right: 12, top: 12, display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-end' }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <button className="secondary" title="Equipped items" onClick={() => setEquipOpen((v) => !v)}
              style={{ borderRadius: 6, padding: '7px 12px', fontSize: 13, lineHeight: 1, border: '1px solid var(--line)', background: equipOpen ? 'var(--accent)' : 'var(--panel)', color: equipOpen ? '#fff' : 'var(--text)' }}>Equipped{equipList.length ? ` (${equipList.length})` : ''}</button>
            <div style={{ display: 'flex', border: '1px solid var(--line)', borderRadius: 6, overflow: 'hidden' }}>
              <button className="secondary" title="Free orbit" onClick={() => setCamPreset('orbit')}
                style={{ borderRadius: 0, padding: '5px 11px', fontSize: 24, lineHeight: 1, background: camMode === 'orbit' ? 'var(--accent)' : 'var(--panel)', color: camMode === 'orbit' ? '#fff' : 'var(--text)' }}>⟳</button>
              <button className="secondary" title="PZ iso" onClick={() => setCamPreset('iso')}
                style={{ borderRadius: 0, padding: '5px 11px', fontSize: 24, lineHeight: 1, background: camMode === 'iso' ? 'var(--accent)' : 'var(--panel)', color: camMode === 'iso' ? '#fff' : 'var(--text)' }}>◈</button>
            </div>
          </div>
          {/* Facing compass: only meaningful under the fixed PZ iso camera, so it appears
              beneath the iso button and hides in free orbit. */}
          {camMode === 'iso' && (
            <div title="Facing" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 34px)', gap: 3, background: '#0e0e13cc', border: '1px solid var(--line)', borderRadius: 8, padding: 5 }}>
              {FACING_GRID.map((cell, i) => cell === null ? <span key={i} /> : (
                <button key={i} className="secondary" onClick={() => { setFacing(cell[1]); engineRef.current?.setFacing(cell[1]); }}
                  style={{ padding: '6px 0', fontSize: 11, lineHeight: 1, background: facing === cell[1] ? 'var(--accent)' : 'var(--panel)', color: facing === cell[1] ? '#fff' : 'var(--text)' }}>{cell[0]}</button>
              ))}
            </div>
          )}
        </div>
        {equipOpen && (
          <div style={{ position: 'absolute', right: 12, top: 54, width: 264, maxHeight: '68%', overflow: 'auto', background: '#0e0e13f2', border: '1px solid var(--line)', borderRadius: 8, padding: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>Equipped ({equipList.length})</span>
              <span role="button" onClick={() => setEquipOpen(false)} title="close" style={{ cursor: 'pointer', color: 'var(--muted)', padding: '0 4px' }}>✕</span>
            </div>
            {!equipList.length && <div style={{ color: 'var(--muted)', fontSize: 12, padding: '8px 4px' }}>Nothing equipped.</div>}
            {equipList.map((e) => (
              <div key={e.type + ':' + e.name} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 2px' }}>
                <span style={{ flex: 1, fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', opacity: e.hidden ? 0.45 : 1 }} title={e.name}>{e.name}</span>
                <span style={{ fontSize: 9, color: 'var(--muted)', border: '1px solid var(--line)', borderRadius: 3, padding: '0 3px' }}>{e.type === 'held' ? 'held' : 'worn'}</span>
                <button className="secondary" title={e.hidden ? 'show in scene' : 'hide from scene'} onClick={() => toggleHide(e.name, !e.hidden)} style={{ padding: '2px 8px', fontSize: 11, minWidth: 44 }}>{e.hidden ? 'show' : 'hide'}</button>
                <button className="secondary" title="remove (unequip)" onClick={() => removeEquip(e.name, e.type)} style={{ padding: '2px 8px', fontSize: 12, color: '#ff6b6b' }}>✕</button>
              </div>
            ))}
          </div>
        )}
        <div style={{ position: 'absolute', left: 12, bottom: 12, right: 12, display: 'flex', gap: 8, alignItems: 'center', background: '#000000aa', borderRadius: 8, padding: '6px 10px' }}>
          <button className="secondary" onClick={togglePlay} style={{ padding: '4px 12px' }}>{playing ? '❚❚' : '▶'}</button>
          <input ref={scrubRef} type="range" min={0} max={1000} defaultValue={0}
            onMouseDown={() => { scrubbingRef.current = true; }} onMouseUp={() => { scrubbingRef.current = false; }}
            onInput={(e) => engineRef.current?.seek(Number((e.target as HTMLInputElement).value) / 1000)}
            style={{ flex: 1, accentColor: '#5b8cff' }} />
          <button className="secondary" onClick={() => { const n = !loop; setLoop(n); engineRef.current?.setLoop(n); }}
            style={{ padding: '4px 10px', background: loop ? 'var(--accent)' : 'var(--panel)', color: loop ? '#fff' : 'var(--text)' }}>loop</button>
          <select value={speed} onChange={(e) => { const s = Number(e.target.value); setSpeed(s); engineRef.current?.setSpeed(s); }}
            style={{ background: 'var(--panel)', color: 'var(--text)', border: '1px solid var(--line)', borderRadius: 6, padding: '4px 6px' }}>
            {[0.25, 0.5, 1, 2].map((s) => <option key={s} value={s}>{s}×</option>)}
          </select>
        </div>
      </div>

      <div onMouseDown={startDrag} title="drag to resize" style={{ width: 12, cursor: 'col-resize', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <div style={{ width: 4, height: 44, borderRadius: 2, background: 'var(--line)' }} />
      </div>

      <div style={{ width: panelW, flexShrink: 0, minWidth: 300, display: 'flex', flexDirection: 'column', minHeight: 0, background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 8 }}>
        <div style={{ display: 'flex', borderBottom: '1px solid var(--line)' }}>
          {tabs.map(([t, label]) => (
            <button key={t} onClick={() => setTab(t)} className="secondary" style={{ flex: 1, borderRadius: 0, background: tab === t ? 'var(--accent)' : 'transparent', color: tab === t ? '#fff' : 'var(--text)' }}>{label}</button>
          ))}
        </div>

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
              items={clothing as (typeof clothing[number] & GridItem)[]}
              facetLabel="groups"
              facetOrder={CLOTHING_GROUP_ORDER as string[]}
              active={(it) => { void equipTick; return !!engineRef.current?.isEquipped(it.name); }}
              onPick={(it) => toggleCloth(it)}
              favActive={(it) => favs.has(favKey('clothing', it.name))}
              onToggleFav={(it) => toggleFav('clothing', it.name)}
              extraControls={(
                <div style={{ display: 'flex', border: '1px solid var(--line)', borderRadius: 6, overflow: 'hidden' }} title="thumbnail style">
                  <button className="secondary" onClick={() => setClothOnBody(true)} style={segBtn(clothOnBody)}>on body</button>
                  <button className="secondary" onClick={() => setClothOnBody(false)} style={segBtn(!clothOnBody)}>item</button>
                </div>
              )}
              renderThumb={(it) => <Thumb depKey={`c:${it.name}:${gender}:${clothOnBody}`} getUrl={() => thumbs.clothing(it, gender, clothOnBody)} />} />
          )}

          {tab === 'held' && (
            <AssetGrid<typeof held[number] & GridItem>
              items={held as (typeof held[number] & GridItem)[]}
              facetLabel="types"
              facetOrder={HELD_GROUP_ORDER as string[]}
              active={(it) => { void equipTick; return !!engineRef.current?.isHeld(it.name); }}
              onPick={(it) => toggleHeld(it)}
              favActive={(it) => favs.has(favKey('held', it.name))}
              onToggleFav={(it) => toggleFav('held', it.name)}
              tagsOf={(it) => it.tags}
              renderThumb={(it) => <Thumb depKey={`h:${it.name}`} getUrl={() => thumbs.held(it)} />} />
          )}

          {tab === 'character' && <CharacterTab hairData={hairData} gender={gender} setGender={setGender} skin={skin} tones={tones} onSkin={(t) => { setSkin(t); engineRef.current?.setSkin(t); }} thumbs={thumbs} hairSel={hairSel} beardSel={beardSel} hairColor={hairColor} beardColor={beardColor} onPickPart={applyHairPart} onRecolour={recolourPart} favs={favs} onToggleFav={toggleFav} onImport={() => setImportOpen(true)} />}

          {tab === 'floor' && (
            <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
              <div style={{ padding: 8, borderBottom: '1px solid var(--line)', display: 'flex', gap: 6, alignItems: 'center' }}>
                <button className="secondary" onClick={clearFloor} style={{ background: !floorSel ? 'var(--accent)' : 'var(--panel)', color: !floorSel ? '#fff' : 'var(--text)' }}>None</button>
                <span style={{ color: 'var(--muted)', fontSize: 12 }}>Browse any single floor tile (material presets are in the Scene tab)</span>
              </div>
              <div style={{ flex: 1, minHeight: 0 }}>
                {floorItems.length ? (
                  <AssetGrid<typeof floorItems[number] & GridItem>
                    items={floorItems as (typeof floorItems[number] & GridItem)[]}
                    facetLabel="categories"
                    active={(it) => it.name === floorSel}
                    onPick={(it) => pickFloor(it.name)}
                    renderThumb={(it) => <Thumb depKey={`floor:${it.name}`} getUrl={() => floorLib.thumbUrl(it.name)} />} />
                ) : <div style={{ padding: 20, color: 'var(--muted)' }}>Loading floor tiles…</div>}
              </div>
            </div>
          )}

          {tab === 'scene' && <SceneTab engineRef={engineRef} floorSel={floorSel} onPreset={pickPreset} onClear={clearFloor}
            studio={{ camPreset, setCamPreset, studioAspect, setStudioAspect, bg, setBg, turntable, setTurntable, gifMode, setGifMode, mp4Seconds, setMp4Seconds, exporting, runExport }} />}
        </div>
      </div>
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
const LIGHT_DEFAULT = { ambient: 0.55, keyBright: 0.5, kx: 0.12, ky: 0.28, kz: 1.0 };

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

function SceneTab({ engineRef, floorSel, onPreset, onClear, studio }: {
  engineRef: React.MutableRefObject<CharacterEngine | null>;
  floorSel: string | null; onPreset: (name: string, tiles: string[]) => void; onClear: () => void;
  studio: StudioCtl;
}) {
  const [grid, setGrid] = useState(true);
  const [shadow, setShadow] = useState(true);
  const [light, setLight] = useState({ ...LIGHT_DEFAULT });

  const setL = (k: keyof typeof LIGHT_DEFAULT, v: number) => { setLight((s) => ({ ...s, [k]: v })); engineRef.current?.setLight(k as 'ambient' | 'keyBright' | 'kx' | 'ky' | 'kz', v); };
  const resetL = () => { setLight({ ...LIGHT_DEFAULT }); engineRef.current?.resetLight(); };

  const label = { color: 'var(--muted)', fontSize: 12, display: 'block', margin: '14px 0 6px' } as const;
  const slider = (k: keyof typeof LIGHT_DEFAULT, name: string, min: number, max: number) => (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
      <span style={{ width: 66, fontSize: 12, color: 'var(--muted)' }}>{name}</span>
      <input type="range" min={min} max={max} step={0.01} value={light[k]} onChange={(e) => setL(k, Number(e.target.value))} style={{ flex: 1, accentColor: '#5b8cff' }} />
      <span style={{ width: 38, fontSize: 12, textAlign: 'right', fontFamily: 'monospace' }}>{light[k].toFixed(2)}</span>
    </div>
  );

  return (
    <div style={{ padding: 12, overflow: 'auto', height: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '0 0 6px' }}>
        <span style={{ color: 'var(--muted)', fontSize: 12 }}>Lighting</span>
        <button className="secondary" onClick={resetL} style={{ padding: '3px 10px', fontSize: 12 }}>Reset</button>
      </div>
      {slider('ambient', 'ambient', 0, 1)}
      {slider('keyBright', 'key light', 0, 1)}
      {slider('kx', 'key X', -2, 2)}
      {slider('ky', 'key Y', -2, 2)}
      {slider('kz', 'key Z', -2, 2)}

      <label style={label}>Floor</label>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button className="secondary" onClick={onClear} style={{ padding: '6px 12px', background: !floorSel ? 'var(--accent)' : 'var(--panel)', color: !floorSel ? '#fff' : 'var(--text)' }}>None</button>
        {FLOOR_PRESETS.map(([name, tiles]) => (
          <button key={name} className="secondary" onClick={() => onPreset(name, tiles)}
            style={{ padding: '6px 12px', background: floorSel === 'preset:' + name ? 'var(--accent)' : 'var(--panel)', color: floorSel === 'preset:' + name ? '#fff' : 'var(--text)' }}>{name}</button>
        ))}
      </div>

      <label style={label}>Scene</label>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="secondary" onClick={() => { const n = !grid; setGrid(n); engineRef.current?.setGridVisible(n); }}
          style={{ padding: '6px 12px', background: grid ? 'var(--accent)' : 'var(--panel)', color: grid ? '#fff' : 'var(--text)' }}>Floor grid</button>
        <button className="secondary" onClick={() => { const n = !shadow; setShadow(n); engineRef.current?.setShadowVisible(n); }}
          style={{ padding: '6px 12px', background: shadow ? 'var(--accent)' : 'var(--panel)', color: shadow ? '#fff' : 'var(--text)' }}>Shadow</button>
      </div>

      <ExportSection studio={studio} />
    </div>
  );
}

// Studio / export controls: camera presets, framing aspect (letterboxed viewfinder in the
// live view), background, and the PNG/GIF/MP4 exporters.
function ExportSection({ studio }: { studio: StudioCtl }) {
  const s = studio;
  const busy = !!s.exporting;
  const label = { color: 'var(--muted)', fontSize: 12, display: 'block', margin: '14px 0 6px' } as const;
  const seg = (on: boolean) => ({ borderRadius: 0, padding: '6px 10px', background: on ? 'var(--accent)' : 'var(--panel)', color: on ? '#fff' : 'var(--muted)', fontSize: 12 }) as const;
  const chip = (on: boolean) => ({ padding: '6px 11px', borderRadius: 6, background: on ? 'var(--accent)' : 'var(--panel)', color: on ? '#fff' : 'var(--text)', fontSize: 12 }) as const;
  const CAMS: [CamPreset, string][] = [['orbit', 'Free'], ['iso', 'PZ iso'], ['front', 'Front 35mm'], ['portrait', 'Portrait 60mm']];

  return (
    <div style={{ marginTop: 20, paddingTop: 6, borderTop: '1px solid var(--line)' }}>
      <div style={{ color: 'var(--text)', fontSize: 13, fontWeight: 600, margin: '10px 0 2px' }}>Export studio</div>

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
        {s.bg.mode !== 'transparent' && <input type="color" value={s.bg.color1} onChange={(e) => s.setBg({ ...s.bg, color1: e.target.value })} title="colour 1" style={{ width: 32, height: 28, padding: 0, border: '1px solid var(--line)', borderRadius: 6, background: 'transparent' }} />}
        {s.bg.mode === 'gradient' && <input type="color" value={s.bg.color2} onChange={(e) => s.setBg({ ...s.bg, color2: e.target.value })} title="colour 2" style={{ width: 32, height: 28, padding: 0, border: '1px solid var(--line)', borderRadius: 6, background: 'transparent' }} />}
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
        GIF “Clip loop” captures one full loop of the current animation at your chosen playback speed, for seamless loops. Transparent background applies to PNG + GIF; video always uses the chosen colour. Everything is generated in your browser, and nothing is uploaded.
      </div>
    </div>
  );
}

const hexRgb = (hex: string) => { const n = parseInt(hex.slice(1), 16); return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; };
const toHairItem = (s: HairStyle): HairItem => ({ ...s, key: s.name, label: s.name, facet: firstLetter(s.name), isMod: false });
const NONE_HAIR: HairItem = { name: 'None', key: 'None', label: 'None', facet: '·', isMod: false };

// Character tab: identity (gender + skin texture) as a compact header, then a browsable
// thumbnail grid for the active appearance kind (Hair or Beard) filling the rest. Selection
// and colour are lifted to the parent so the Favorites tab stays in sync.
function CharacterTab({ hairData, gender, setGender, skin, tones, onSkin, thumbs, hairSel, beardSel, hairColor, beardColor, onPickPart, onRecolour, favs, onToggleFav, onImport }: {
  hairData: HairData;
  gender: 'male' | 'female';
  setGender: (g: 'male' | 'female') => void;
  skin: string;
  tones: string[];
  onSkin: (tone: string) => void;
  thumbs: ThumbnailProvider;
  hairSel: string;
  beardSel: string;
  hairColor: string;
  beardColor: string;
  onPickPart: (kind: 'hair' | 'beard', style: HairStyle) => void;
  onRecolour: (kind: 'hair' | 'beard', hex: string) => void;
  favs: Set<string>;
  onToggleFav: (kind: FavKind, name: string) => void;
  onImport: () => void;
}) {
  const [kind, setKind] = useState<'hair' | 'beard'>('hair');

  const hairItems = useMemo(() => [NONE_HAIR, ...(gender === 'female' ? hairData.hair.female : hairData.hair.male).map(toHairItem)], [hairData, gender]);
  const beardItems = useMemo(() => [NONE_HAIR, ...hairData.beards.map(toHairItem)], [hairData]);
  const items = kind === 'hair' ? hairItems : beardItems;
  const selected = kind === 'hair' ? hairSel : beardSel;
  const color = kind === 'hair' ? hairColor : beardColor;

  // 'MaleBody03a' -> '3h' (body-hair variant), 'FemaleBody02' -> '2'
  const toneLabel = (t: string) => { const m = t.match(/(\d+)(a?)$/); return m ? String(parseInt(m[1], 10)) + (m[2] ? 'h' : '') : t; };
  const seg = (on: boolean) => ({ borderRadius: 0, padding: '6px 14px', background: on ? 'var(--accent)' : 'var(--panel)', color: on ? '#fff' : 'var(--muted)' }) as const;
  const chip = (on: boolean) => ({ minWidth: 34, borderRadius: 6, padding: '7px 8px', background: on ? 'var(--accent)' : '#14141a', color: on ? '#fff' : 'var(--text)', border: '1px solid var(--line)' }) as const;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ padding: 12, borderBottom: '1px solid var(--line)' }}>
        <button className="secondary" onClick={onImport} style={{ width: '100%', padding: '8px 12px', marginBottom: 12, background: 'var(--accent)', color: '#fff' }}>Import look from a save…</button>
        <label style={{ color: 'var(--muted)', fontSize: 12 }}>Gender</label>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '4px 0 12px' }}>
          <div style={{ display: 'flex', border: '1px solid var(--line)', borderRadius: 6, overflow: 'hidden' }}>
            {(['male', 'female'] as const).map((g) => (
              <button key={g} className="secondary" onClick={() => setGender(g)} style={seg(gender === g)}>{g}</button>
            ))}
          </div>
        </div>
        <label style={{ color: 'var(--muted)', fontSize: 12 }}>Skin</label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
          {tones.map((t) => (
            <button key={t} className="secondary" title={t} onClick={() => onSkin(t)} style={chip(skin === t)}>{toneLabel(t)}</button>
          ))}
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <AssetGrid<HairItem>
          key={kind}
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
              <input type="color" value={color} onChange={(e) => onRecolour(kind, e.target.value)} title="colour" style={{ width: 34, height: 30, padding: 0, border: '1px solid var(--line)', borderRadius: 6, background: 'transparent' }} />
            </>
          )}
          renderThumb={(it) => it.name === 'None'
            ? <span style={{ color: 'var(--muted)', fontSize: 13 }}>None</span>
            : <Thumb depKey={`hair:${kind}:${it.name}:${gender}`} getUrl={() => thumbs.hair(it, kind, gender)} />} />
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
  const pick = async () => {
    setBusy('Opening folder…');
    try {
      const dir = await window.showDirectoryPicker({ id: 'pz-saves', mode: 'read' });
      setBusy('Scanning saves…');
      const s = await discoverSaves(dir);
      setSaves(s); setBusy(s.length ? '' : 'No saves with a character were found in that folder.');
    } catch (e) { setBusy((e as Error)?.name === 'AbortError' ? '' : 'error: ' + (e as Error).message); }
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
    <div style={{ position: 'fixed', inset: 0, background: '#000000aa', zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 540, maxWidth: '92vw', maxHeight: '82vh', background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 10, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--line)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontWeight: 600 }}>Import character look from a save</span>
          <span role="button" onClick={onClose} title="close" style={{ cursor: 'pointer', color: 'var(--muted)' }}>✕</span>
        </div>
        <div style={{ padding: 14, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button className="secondary" onClick={pick} style={{ padding: '8px 14px', background: 'var(--accent)', color: '#fff' }}>{saves ? 'Choose another folder' : 'Choose your Zomboid folder…'}</button>
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
