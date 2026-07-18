import { useEffect, useMemo, useRef, useState } from 'react';
import { listClips, listClothing, listHeldItems, listHair, clothingGroup, CLOTHING_GROUP_ORDER, SKIN_TONES } from '@shared/character-core.js';
import { CharacterEngine, type Ctx } from './render/character-engine';
import { ThumbnailProvider } from './render/thumbnail-provider';
import { ClipPreview } from './render/clip-preview';
import { FloorLibrary } from './render/floor';
import { AssetGrid, type GridItem } from './AssetGrid';
import { Thumb } from './Thumb';

type Tab = 'animate' | 'clothing' | 'held' | 'character' | 'scene' | 'floor';
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
  const [gender, setGender] = useState<'male' | 'female'>('male');
  const [skin, setSkin] = useState<string>((SKIN_TONES as Record<string, string[]>).male[0]);
  const tones = (SKIN_TONES as Record<string, string[]>)[gender];
  const [status, setStatus] = useState('loading body…');
  const [nowPlaying, setNowPlaying] = useState('');
  const [playing, setPlaying] = useState(true);
  const [tab, setTab] = useState<Tab>('animate');
  const [equipTick, setEquipTick] = useState(0);
  const [, setBusy] = useState('');
  const [panelW, setPanelW] = useState(() => Number(localStorage.getItem('pz-panel-w')) || 420);
  const [clothOnBody, setClothOnBody] = useState(true);
  const [loop, setLoop] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [camMode, setCamMode] = useState<'orbit' | 'iso'>('orbit');
  const scrubRef = useRef<HTMLInputElement>(null);
  const scrubbingRef = useRef(false);

  const clips: Clip[] = useMemo(() => listClips(index), [index]);
  const clipItems = useMemo(() => clips.map((c) => ({ ...c, key: c.id, label: c.name, facet: clipCategory(c.name), source: c.modName || 'Vanilla' })), [clips]);
  const [currentClipId, setCurrentClipId] = useState<string | null>(null);
  const clothing = useMemo(() => (listClothing(index) as Array<{ name: string; kind: string; location: string; isMod: boolean; modName?: string | null }>)
    .map((c) => ({ ...c, key: c.name, label: c.name, facet: clothingGroup(c), source: c.modName || 'Vanilla' })), [index]);
  const held = useMemo(() => (listHeldItems(index) as Array<{ name: string; isMod?: boolean; modName?: string | null }>)
    .map((h) => ({ ...h, key: h.name, label: h.name, facet: firstLetter(h.name), isMod: !!h.isMod, source: h.modName || 'Vanilla' })), [index]);
  const hairData = useMemo(() => listHair(index) as { hair: { male: { name: string }[]; female: { name: string }[] }; beards: { name: string }[] }, [index]);

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
      // a single-variant preset (e.g. Wood) needs no variation/blend — use the clean single-tile path
      if (tiles.length === 1) engineRef.current?.setFloor(await floorLib.texture(tiles[0]), 1);
      else engineRef.current?.setFloor(await floorLib.presetTexture(tiles, name, 8), 8);
    } catch { /* ignore */ }
  };
  const clearFloor = () => { setFloorSel(null); engineRef.current?.setFloor(null); };
  useEffect(() => { if (tab === 'floor' && !floorTiles.length) floorLib.list().then((ts) => setFloorTiles(ts as { name: string }[])).catch(() => {}); }, [tab, floorLib, floorTiles.length]);
  // scrolling detaches the fixed-position hover preview from its cell — hide it
  useEffect(() => { const off = () => preview.stop(); window.addEventListener('wheel', off, { passive: true }); return () => window.removeEventListener('wheel', off); }, [preview]);
  useEffect(() => { localStorage.setItem('pz-panel-w', String(panelW)); }, [panelW]);


  // engine once; refit the canvas whenever its container resizes (window OR splitter drag)
  useEffect(() => {
    const eng = new CharacterEngine(canvasRef.current!, ctx);
    eng.onClipName = setNowPlaying;
    eng.onFrame = (t, dur) => { const el = scrubRef.current; if (el && !scrubbingRef.current) el.value = String(dur ? ((t % dur) / dur) * 1000 : 0); };
    eng.onCamMode = setCamMode; // keep the Scene-tab toggle in sync with auto-switches
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
        setSkin((SKIN_TONES as Record<string, string[]>)[gender][0]); // gender load resets to the default tone
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

  const tabs: [Tab, string][] = [['animate', 'Animate'], ['clothing', 'Clothing'], ['held', 'Held'], ['character', 'Character'], ['floor', 'Floor'], ['scene', 'Scene']];
  const segBtn = (on: boolean) => ({ borderRadius: 0, padding: '6px 9px', background: on ? 'var(--accent)' : 'var(--panel)', color: on ? '#fff' : 'var(--muted)' }) as const;

  return (
    <div ref={containerRef} style={{ display: 'flex', height: 'calc(100vh - 128px)', minHeight: 460 }}>
      <div style={{ flex: 1, minWidth: 320, position: 'relative', background: '#14141a', border: '1px solid var(--line)', borderRadius: 8, overflow: 'hidden' }}>
        <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
        <div style={{ position: 'absolute', left: 12, top: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
          {status && <span style={{ color: 'var(--muted)', background: '#00000099', padding: '4px 8px', borderRadius: 6 }}>{status}</span>}
          <span style={{ color: 'var(--muted)', background: '#00000099', padding: '4px 8px', borderRadius: 6, maxWidth: 340, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{nowPlaying || 'pick a clip →'}</span>
        </div>
        <div style={{ position: 'absolute', right: 12, top: 12, display: 'flex', border: '1px solid var(--line)', borderRadius: 6, overflow: 'hidden' }}>
          <button className="secondary" title="Free orbit" onClick={() => engineRef.current?.setCamMode('orbit')}
            style={{ borderRadius: 0, padding: '5px 11px', fontSize: 24, lineHeight: 1, background: camMode === 'orbit' ? 'var(--accent)' : 'var(--panel)', color: camMode === 'orbit' ? '#fff' : 'var(--text)' }}>⟳</button>
          <button className="secondary" title="PZ iso" onClick={() => engineRef.current?.setCamMode('iso')}
            style={{ borderRadius: 0, padding: '5px 11px', fontSize: 24, lineHeight: 1, background: camMode === 'iso' ? 'var(--accent)' : 'var(--panel)', color: camMode === 'iso' ? '#fff' : 'var(--text)' }}>◈</button>
        </div>
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
              facetLabel="letters"
              active={(it) => { void equipTick; return !!engineRef.current?.isHeld(it.name); }}
              onPick={(it) => toggleHeld(it)}
              renderThumb={(it) => <Thumb depKey={`h:${it.name}`} getUrl={() => thumbs.held(it)} />} />
          )}

          {tab === 'character' && <CharacterTab hairData={hairData} gender={gender} setGender={setGender} skin={skin} tones={tones} onSkin={(t) => { setSkin(t); engineRef.current?.setSkin(t); }} engineRef={engineRef} />}

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

          {tab === 'scene' && <SceneTab engineRef={engineRef} floorSel={floorSel} onPreset={pickPreset} onClear={clearFloor} />}
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

function SceneTab({ engineRef, floorSel, onPreset, onClear }: {
  engineRef: React.MutableRefObject<CharacterEngine | null>;
  floorSel: string | null; onPreset: (name: string, tiles: string[]) => void; onClear: () => void;
}) {
  const [facing, setFacing] = useState<number | null>(0);
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
      <label style={{ ...label, marginTop: 0 }}>Facing</label>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 52px)', gap: 4 }}>
        {FACING_GRID.map((cell, i) => cell === null ? <span key={i} /> : (
          <button key={i} className="secondary" onClick={() => { setFacing(cell[1]); engineRef.current?.setFacing(cell[1]); }}
            style={{ padding: '8px 0', background: facing === cell[1] ? 'var(--accent)' : 'var(--panel)', color: facing === cell[1] ? '#fff' : 'var(--text)' }}>{cell[0]}</button>
        ))}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '18px 0 6px' }}>
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
    </div>
  );
}

// Character tab: identity (gender + skin texture) above appearance (hair + beard).
function CharacterTab({ hairData, gender, setGender, skin, tones, onSkin, engineRef }: {
  hairData: { hair: { male: { name: string }[]; female: { name: string }[] }; beards: { name: string }[] };
  gender: 'male' | 'female';
  setGender: (g: 'male' | 'female') => void;
  skin: string;
  tones: string[];
  onSkin: (tone: string) => void;
  engineRef: React.MutableRefObject<CharacterEngine | null>;
}) {
  const [hair, setHair] = useState('None');
  const [beard, setBeard] = useState('None');
  const [hairColor, setHairColor] = useState('#5a3a20');
  const [beardColor, setBeardColor] = useState('#5a3a20');
  const hairList = gender === 'female' ? hairData.hair.female : hairData.hair.male;
  const hexRgb = (hex: string) => { const n = parseInt(hex.slice(1), 16); return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; };
  const apply = (kind: 'hair' | 'beard', name: string, color: string) => {
    const list = kind === 'beard' ? hairData.beards : hairList;
    const style = name === 'None' ? { name: 'None' } : list.find((s) => s.name === name) || { name };
    engineRef.current?.applyPart(kind, style, hexRgb(color)).catch(() => {});
  };
  // 'MaleBody03a' -> '3h' (body-hair variant), 'FemaleBody02' -> '2'
  const toneLabel = (t: string) => { const m = t.match(/(\d+)(a?)$/); return m ? String(parseInt(m[1], 10)) + (m[2] ? 'h' : '') : t; };
  const row = { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 } as const;
  const sel = { flex: 1, background: '#14141a', color: 'var(--text)', border: '1px solid var(--line)', borderRadius: 6, padding: '7px 9px' } as const;
  const seg = (on: boolean) => ({ borderRadius: 0, padding: '6px 14px', background: on ? 'var(--accent)' : 'var(--panel)', color: on ? '#fff' : 'var(--muted)' }) as const;
  const chip = (on: boolean) => ({ minWidth: 34, borderRadius: 6, padding: '7px 8px', background: on ? 'var(--accent)' : '#14141a', color: on ? '#fff' : 'var(--text)', border: '1px solid var(--line)' }) as const;
  return (
    <div style={{ padding: 12 }}>
      <label style={{ color: 'var(--muted)', fontSize: 12 }}>Gender</label>
      <div style={{ ...row, marginTop: 4 }}>
        <div style={{ display: 'flex', border: '1px solid var(--line)', borderRadius: 6, overflow: 'hidden' }}>
          {(['male', 'female'] as const).map((g) => (
            <button key={g} className="secondary" onClick={() => setGender(g)} style={seg(gender === g)}>{g}</button>
          ))}
        </div>
      </div>
      <label style={{ color: 'var(--muted)', fontSize: 12 }}>Skin</label>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '4px 0 14px' }}>
        {tones.map((t) => (
          <button key={t} className="secondary" title={t} onClick={() => onSkin(t)} style={chip(skin === t)}>{toneLabel(t)}</button>
        ))}
      </div>
      <label style={{ color: 'var(--muted)', fontSize: 12 }}>Hair</label>
      <div style={row}>
        <select style={sel} value={hair} onChange={(e) => { setHair(e.target.value); apply('hair', e.target.value, hairColor); }}>
          <option>None</option>{hairList.map((s) => <option key={s.name}>{s.name}</option>)}
        </select>
        <input type="color" value={hairColor} onChange={(e) => { setHairColor(e.target.value); apply('hair', hair, e.target.value); }} />
      </div>
      <label style={{ color: 'var(--muted)', fontSize: 12 }}>Beard</label>
      <div style={row}>
        <select style={sel} value={beard} onChange={(e) => { setBeard(e.target.value); apply('beard', e.target.value, beardColor); }}>
          <option>None</option>{hairData.beards.map((s) => <option key={s.name}>{s.name}</option>)}
        </select>
        <input type="color" value={beardColor} onChange={(e) => { setBeardColor(e.target.value); apply('beard', beard, e.target.value); }} />
      </div>
    </div>
  );
}
