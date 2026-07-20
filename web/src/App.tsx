import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { buildAssetIndex } from '@shared/asset-index.js';
import { listClothing, listClips, listHair, listHeldItems } from '@shared/character-core.js';
import { createFsaAssetSource } from './platform/fsa-source';
import { discoverWorkshopMods, modSources, type DiscoveredMod } from './platform/mod-discovery';
import { idbHandles, idbCache, hasPermission, requestPermission, storageUsage } from './platform/idb';
import { converter } from './render/converter';
import { CharacterViewer } from './CharacterViewer';
import logoUrl from './assets/logo.png';
import kofiUrl from './assets/kofi_symbol.svg';

const INSTALL_KEY = 'pz-install';
const WORKSHOP_KEY = 'pz-workshop';
const ACTIVE_KEY = 'pz-active-mods';
const fsaSupported = typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';

type Phase = 'unsupported' | 'idle' | 'need-permission' | 'scanning' | 'ready' | 'error';
type View = 'overview' | 'character';
type ScanStep = 'scripts' | 'clothing' | 'anims';
type Scan = { source: number; total: number; step: ScanStep; count: number; name: string };
const SCAN_STEPS: ScanStep[] = ['scripts', 'clothing', 'anims'];
const STEP_NAME: Record<ScanStep, string> = { scripts: 'Scripts', clothing: 'Clothing', anims: 'Animations' };
const STEP_VERB: Record<ScanStep, string> = { scripts: 'Reading scripts', clothing: 'Reading clothing', anims: 'Indexing animations' };
interface Counts { clothing: number; clips: number; held: number; hairM: number; hairF: number; beards: number; modClothing: number; }

export function App() {
  const [phase, setPhase] = useState<Phase>(fsaSupported ? 'idle' : 'unsupported');
  const [progress, setProgress] = useState('');
  const [scan, setScan] = useState<Scan | null>(null);
  const [overlay, setOverlay] = useState<'in' | 'out' | null>(null); // scan modal: fading in, fading out, or gone
  const [charName, setCharName] = useState<string | null>(null); // name of the loaded saved character
  const [error, setError] = useState('');
  const [counts, setCounts] = useState<Counts | null>(null);
  const [index, setIndex] = useState<unknown>(null);
  const [view, setView] = useState<View>('overview');
  const [installHandle, setInstallHandle] = useState<FileSystemDirectoryHandle | null>(null);
  const [needPerm, setNeedPerm] = useState(false);
  const [mods, setMods] = useState<DiscoveredMod[]>([]);
  const [activeKeys, setActiveKeys] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem(ACTIVE_KEY) || '[]'); } catch { return []; } });

  const ctx = useMemo(() => (index ? { resolver: (index as { resolver: unknown }).resolver, converter } : null), [index]);
  const activeMods = useMemo(() => activeKeys.map((k) => mods.find((m) => m.key === k)).filter(Boolean) as DiscoveredMod[], [activeKeys, mods]);
  useEffect(() => { localStorage.setItem(ACTIVE_KEY, JSON.stringify(activeKeys)); }, [activeKeys]);

  const fadeTimer = useRef<number | null>(null);
  const rebuild = useCallback(async (installH: FileSystemDirectoryHandle, active: DiscoveredMod[]) => {
    // show the scan overlay in the SAME render as phase='scanning' (batched), so it's the first
    // thing on screen - no flash of the empty Sources card before the modal appears.
    if (fadeTimer.current) { clearTimeout(fadeTimer.current); fadeTimer.current = null; }
    setPhase('scanning'); setOverlay('in'); setError('');
    const t0 = performance.now();
    try {
      const sources = [...modSources(active), createFsaAssetSource(installH, { id: 'install', isMod: false })];
      const idx = await buildAssetIndex(sources, { onProgress: (p: Scan) => setScan(p) });
      const clothing = listClothing(idx);
      const { hair, beards } = listHair(idx);
      setCounts({
        clothing: clothing.length, clips: listClips(idx).length, held: listHeldItems(idx).length,
        hairM: hair.male.length, hairF: hair.female.length, beards: beards.length,
        modClothing: clothing.filter((c: { isMod: boolean }) => c.isMod).length,
      });
      setIndex(idx);
      setProgress(`scanned ${sources.length} root${sources.length === 1 ? '' : 's'} in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
      setPhase('ready');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setPhase('error'); }
    finally {
      // fade the modal out (revealing the cards behind it) once the scan settles
      setOverlay('out');
      fadeTimer.current = window.setTimeout(() => { setOverlay(null); setScan(null); fadeTimer.current = null; }, 480);
    }
  }, []);

  // restore install (+ workshop mods) on load
  useEffect(() => {
    if (!fsaSupported) return;
    (async () => {
      const inst = await idbHandles.load(INSTALL_KEY);
      if (!inst) return;
      if (!(await hasPermission(inst))) { setInstallHandle(inst); setNeedPerm(true); return; }
      // Committed to a scan: set the handle AND raise the modal in one batched render, so the
      // Sources card and the modal appear on the same frame (no sources-without-modal flash),
      // and the modal covers mod discovery (reading every mod.info) as well as the rebuild.
      setInstallHandle(inst); setPhase('scanning'); setOverlay('in');
      let discovered: DiscoveredMod[] = [];
      try {
        const ws = await idbHandles.load(WORKSHOP_KEY);
        if (ws && await hasPermission(ws)) { discovered = await discoverWorkshopMods(ws); setMods(discovered); }
      } catch { /* discovery is best-effort; fall through to a vanilla rebuild so the modal never sticks */ }
      const active = JSON.parse(localStorage.getItem(ACTIVE_KEY) || '[]').map((k: string) => discovered.find((m) => m.key === k)).filter(Boolean) as DiscoveredMod[];
      rebuild(inst, active);
    })();
  }, [rebuild]);

  const pickInstall = useCallback(async () => {
    try {
      const h = await window.showDirectoryPicker({ id: 'pz-install', mode: 'read' });
      await idbHandles.save(INSTALL_KEY, h); setInstallHandle(h); setNeedPerm(false);
      rebuild(h, activeMods);
    } catch (e) { if ((e as Error).name !== 'AbortError') setError((e as Error).message); }
  }, [rebuild, activeMods]);

  const reconnect = useCallback(async () => {
    if (!installHandle) return;
    if (await requestPermission(installHandle)) { setNeedPerm(false); rebuild(installHandle, activeMods); }
    else setError('Permission denied.');
  }, [installHandle, rebuild, activeMods]);

  const pickWorkshop = useCallback(async () => {
    try {
      const h = await window.showDirectoryPicker({ id: 'pz-workshop', mode: 'read' });
      await idbHandles.save(WORKSHOP_KEY, h);
      setProgress('discovering mods…');
      // enumeration only (reads each mod.info) - no media scan yet, so it's fast. The user
      // then picks which mods to load and hits Apply, so they never wait on mods they don't want.
      const found = await discoverWorkshopMods(h, (n) => setProgress(`found ${n} mods…`));
      setMods(found);
      setProgress(`found ${found.length} mods; pick the ones you want, then Apply & rescan`);
    } catch (e) { if ((e as Error).name !== 'AbortError') setError((e as Error).message); }
  }, []);

  const toggleMod = (key: string) => setActiveKeys((ks) => ks.includes(key) ? ks.filter((k) => k !== key) : [...ks, key]);
  const addAllMods = () => setActiveKeys(mods.map((m) => m.key));
  const clearMods = () => setActiveKeys([]);
  const moveMod = (key: string, dir: -1 | 1) => setActiveKeys((ks) => {
    const i = ks.indexOf(key); const j = i + dir;
    if (i < 0 || j < 0 || j >= ks.length) return ks;
    const next = ks.slice(); [next[i], next[j]] = [next[j], next[i]]; return next;
  });
  const applyMods = () => { if (installHandle) rebuild(installHandle, activeMods); };

  const [modFilter, setModFilter] = useState('');
  const inactiveAll = mods.filter((m) => !activeKeys.includes(m.key));
  const inactiveMods = inactiveAll.filter((m) => !modFilter || m.name.toLowerCase().includes(modFilter.toLowerCase()));
  const wide = view === 'character' && index != null;

  const firstRun = !installHandle && !counts;

  return (
    <div style={{ maxWidth: wide ? 'none' : 1000, margin: wide ? 0 : '0 auto', padding: wide ? '14px 20px' : '26px 24px 48px' }}>
      <header style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <img src={logoUrl} alt="PZ Character Studio" width={38} height={38} style={{ width: 38, height: 38, borderRadius: 9, objectFit: 'cover', display: 'block', border: '1px solid var(--line)' }} />
          <div>
            <div style={{ fontSize: 19, fontWeight: 700, lineHeight: 1.1 }}>PZ Character Studio</div>
            <div style={{ color: 'var(--muted)', fontSize: 12.5 }}>Dress, pose and export your survivors</div>
          </div>
        </div>
        {charName && <div title="Loaded character" style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', fontSize: 23, fontWeight: 600, color: 'var(--text)', pointerEvents: 'none', whiteSpace: 'nowrap', maxWidth: '40%', overflow: 'hidden', textOverflow: 'ellipsis' }}>{charName}</div>}
        {index != null && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button className="secondary" onClick={() => setView('overview')} style={{ borderColor: view === 'overview' ? 'var(--accent)' : 'var(--line)', color: view === 'overview' ? '#fff' : 'var(--text)' }}>Overview</button>
            <button onClick={() => setView('character')} style={{ padding: '9px 18px', fontWeight: 600, boxShadow: view === 'character' ? 'none' : '0 2px 10px #5b8cff55' }}>Character viewer →</button>
          </div>
        )}
      </header>

      {phase === 'unsupported' && (
        <div className="card" style={{ marginTop: 40, maxWidth: 560, marginInline: 'auto', textAlign: 'center', background: '#2c2226', borderColor: '#5a3a3a' }}>
          <div style={{ fontSize: 30, marginBottom: 8 }}>◈</div>
          <strong style={{ fontSize: 16 }}>This tool needs a Chromium browser</strong>
          <p style={{ color: 'var(--muted)', margin: '8px 0 0' }}>Reading files from your PC uses the File System Access API, supported only by Chrome, Edge, Brave and Opera.</p>
        </div>
      )}

      {phase !== 'unsupported' && view === 'overview' && firstRun && (
        <section style={{ marginTop: 44, textAlign: 'center', maxWidth: 620, marginInline: 'auto' }}>
          <h2 style={{ fontSize: 26, margin: '0 0 12px', lineHeight: 1.2 }}>Bring your survivors to life in the browser</h2>
          <p style={{ color: 'var(--muted)', fontSize: 15, lineHeight: 1.65, margin: '0 0 24px' }}>
            Point the tool at your local Project Zomboid folder to browse every outfit, weapon and animation, dress and pose a character, import a look straight from a save, and export stills, GIFs or MP4s. Everything runs on your machine, and nothing is uploaded.
          </p>
          <button onClick={pickInstall} style={{ padding: '11px 22px', fontSize: 15 }}>Choose your PZ install folder…</button>
          <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 10 }}>The folder that contains <code>media/</code>. Chromium browsers only.</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center', marginTop: 28 }}>
            {['Grids & thumbnails', 'Dress, pose & animate', 'Import from a save', 'Export PNG / GIF / MP4'].map((f) => (
              <span key={f} style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 999, padding: '6px 13px', fontSize: 12.5, color: 'var(--muted)' }}>{f}</span>
            ))}
          </div>
          {error && <p style={{ color: '#ff8a8a', marginTop: 18 }}>Error: {error}</p>}
          <div style={{ textAlign: 'left', marginTop: 28 }}><SafetyInfo /></div>
        </section>
      )}

      {phase !== 'unsupported' && view === 'overview' && !firstRun && (
        <div className="overview-enter" style={{ marginTop: 18, display: 'grid', gap: 14 }}>
          <div className="card">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <b style={{ fontSize: 13 }}>Sources</b>
              {phase === 'scanning' && <span style={{ color: 'var(--muted)', fontSize: 12.5 }}><span className="spinner" /> scanning…</span>}
              {phase === 'ready' && progress && <span style={{ color: 'var(--muted)', fontSize: 12.5, marginLeft: 'auto' }}>{progress}</span>}
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <FolderChip label="Game install" name={installHandle?.name} connected={!!installHandle && !needPerm}
                warn={needPerm ? 'reconnect needed' : undefined} action={needPerm ? 'Reconnect' : 'Change'} onAction={needPerm ? reconnect : pickInstall} disabled={phase === 'scanning'}
                hint={<>The Project Zomboid install folder, which contains a <b>media</b> folder. On Steam: right-click <b>Project Zomboid</b> → <b>Manage</b> → <b>Browse local files</b>. Typical path: <code>Steam\steamapps\common\ProjectZomboid</code>.</>} />
              <FolderChip label="Workshop mods" name={mods.length ? `${mods.length} mods found` : undefined} connected={mods.length > 0}
                action={mods.length ? 'Change' : 'Add'} onAction={pickWorkshop} disabled={phase === 'scanning'}
                hint={<>Your subscribed Steam Workshop mods. In the same Steam library as the game, open <code>steamapps\workshop\content\108600</code> and pick that folder (or its parent). Optional, only needed for modded content.</>} />
            </div>
            {error && <p style={{ color: '#ff8a8a', margin: '10px 0 0' }}>Error: {error}</p>}
            <SafetyInfo />
          </div>

          {mods.length > 0 && (
            <div className="card">
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
                <b style={{ fontSize: 13 }}>Mods</b>
                <span style={{ color: 'var(--muted)', fontSize: 12 }}>{activeMods.length} of {mods.length} active · top of the list overrides those below and vanilla</span>
                <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                  <button className="secondary" onClick={addAllMods} disabled={phase === 'scanning'} style={{ padding: '5px 11px', fontSize: 12 }}>Add all</button>
                  <button className="secondary" onClick={clearMods} disabled={phase === 'scanning'} style={{ padding: '5px 11px', fontSize: 12 }}>Clear</button>
                  <button onClick={applyMods} disabled={!installHandle || phase === 'scanning'} style={{ padding: '5px 13px' }}>Apply & rescan</button>
                </span>
              </div>

              <div className="modlabel" style={{ marginBottom: 6 }}>Active</div>
              <div style={{ maxHeight: 220, overflow: 'auto', display: 'grid', gap: 4 }}>
                {activeMods.map((m, i) => (
                  <div key={m.key} className="modrow">
                    <div style={{ display: 'flex', gap: 3 }}>
                      <button className="iconbtn" onClick={() => moveMod(m.key, -1)} disabled={i === 0} title="move up">↑</button>
                      <button className="iconbtn" onClick={() => moveMod(m.key, 1)} disabled={i === activeMods.length - 1} title="move down">↓</button>
                    </div>
                    <ModName mod={m} />
                    <button className="iconbtn danger" onClick={() => toggleMod(m.key)} title="remove"><TrashIcon /></button>
                  </div>
                ))}
                {!activeMods.length && <div style={{ color: 'var(--muted)', fontSize: 12.5, padding: '10px 4px' }}>No active mods yet. Add some from the list below.</div>}
              </div>

              {inactiveAll.length > 0 && (
                <>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '14px 0 6px' }}>
                    <span className="modlabel">Available</span>
                    <input value={modFilter} onChange={(e) => setModFilter(e.target.value)} placeholder="filter…"
                      style={{ marginLeft: 'auto', width: 170, background: '#14141a', color: 'var(--text)', border: '1px solid var(--line)', borderRadius: 6, padding: '5px 8px', fontSize: 12 }} />
                  </div>
                  <div style={{ maxHeight: 200, overflow: 'auto', display: 'grid', gap: 4 }}>
                    {inactiveMods.map((m) => (
                      <div key={m.key} className="modrow">
                        <ModName mod={m} />
                        <button className="iconbtn add" onClick={() => toggleMod(m.key)} title="add">+</button>
                      </div>
                    ))}
                    {!inactiveMods.length && <div style={{ color: 'var(--muted)', fontSize: 12.5, padding: '10px 4px' }}>No mods match “{modFilter}”.</div>}
                  </div>
                </>
              )}
            </div>
          )}

          {counts && (
            <div className="card">
              <b style={{ fontSize: 13 }}>Library</b>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 10, margin: '14px 0 4px' }}>
                {([['Clothing', counts.clothing, counts.modClothing ? `${counts.modClothing} modded` : null], ['Held items', counts.held, null], ['Animations', counts.clips, null], ['Hair', `${counts.hairM + counts.hairF}`, `${counts.hairM} M · ${counts.hairF} F`], ['Beards', counts.beards, null]] as const).map(([label, n, sub]) => (
                  <div key={label} style={{ background: '#14141a', border: '1px solid var(--line)', borderRadius: 9, padding: '12px 14px' }}>
                    <div style={{ fontSize: 22, fontWeight: 700, lineHeight: 1.1 }}>{n}</div>
                    <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 2 }}>{label}</div>
                    {sub && <div style={{ color: 'var(--accent)', fontSize: 11, marginTop: 3 }}>{sub}</div>}
                  </div>
                ))}
              </div>
              <CacheInfo />
            </div>
          )}
        </div>
      )}

      {index != null && view === 'character' && ctx && (
        <div style={{ marginTop: 12 }}><CharacterViewer ctx={ctx} index={index} onCharacterName={setCharName} /></div>
      )}

      <div className="credit">
        <a className="watermark" href="https://steamcommunity.com/id/mreastman/myworkshopfiles/?appid=108600"
          target="_blank" rel="noopener noreferrer" title="RedChili on the Steam Workshop">Made by RedChili</a>
        <a className="kofi-link" href="https://ko-fi.com/redchili" target="_blank" rel="noopener noreferrer"
          title="Support RedChili on Ko-fi" aria-label="Support RedChili on Ko-fi">
          <img src={kofiUrl} alt="" />
        </a>
      </div>

      {overlay && <ScanOverlay scan={scan} closing={overlay === 'out'} />}
    </div>
  );
}

// Full-screen scanning modal: blurs the page behind it, shows a live progress bar + step chips,
// then fades out to reveal the freshly-scanned library.
function ScanOverlay({ scan, closing }: { scan: Scan | null; closing: boolean }) {
  const stepIdx = scan ? SCAN_STEPS.indexOf(scan.step) : 0;
  // scan === null is the "preparing" window (discovering mods, before per-source progress
  // reports start): show a small shimmering bar, not a full one that reads as done/stuck.
  const pct = closing ? 100 : !scan ? 6 : Math.min(99, Math.round(((scan.source - 1) * 3 + stepIdx + 1) / (scan.total * 3) * 100));
  return (
    <div className={'scan-overlay' + (closing ? ' closing' : '')} role="status" aria-live="polite">
      <div className="scan-card">
        <img src={logoUrl} className="scan-logo" width={54} height={54} alt="" />
        <div className="scan-title">{closing ? 'Ready' : 'Scanning your game files'}</div>
        <div className="scan-sub">{scan ? `Source ${scan.source} of ${scan.total} · ${scan.name}` : 'Preparing…'}</div>
        <div className="scan-bar"><div className="scan-bar-fill" style={{ width: pct + '%' }} /></div>
        <div className="scan-steps">
          {SCAN_STEPS.map((st, i) => (
            <div key={st} className={'scan-step' + (closing || i < stepIdx ? ' done' : i === stepIdx ? ' active' : '')}>
              <span className="scan-step-dot" />{STEP_NAME[st]}
            </div>
          ))}
        </div>
        <div className="scan-detail">{scan && !closing ? <>{STEP_VERB[scan.step]}… <b>{scan.count.toLocaleString()}</b> found</> : 'Building your library…'}</div>
      </div>
    </div>
  );
}

// Plain-language explanation of why the tool reads local files and why that is safe.
function SafetyInfo() {
  return (
    <details className="safety" style={{ marginTop: 12, background: '#14141a', border: '1px solid var(--line)', borderRadius: 9 }}>
      <summary style={{ padding: '11px 13px', fontWeight: 600, fontSize: 13, display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ width: 22, height: 22, borderRadius: 6, background: '#1c2748', color: '#7ea6ff', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2l8 3.1v5.2c0 4.9-3.4 9.2-8 10.5-4.6-1.3-8-5.6-8-10.5V5.1z" /></svg>
        </span>
        Why does it need my files, and is it safe?
        <span className="chev" style={{ marginLeft: 'auto', color: 'var(--muted)' }}>▾</span>
      </summary>
      <div style={{ padding: '2px 14px 14px', color: 'var(--muted)', fontSize: 13, lineHeight: 1.6 }}>
        <h4>Why it needs your files</h4>
        <p>Project Zomboid stores its characters as 3D models, textures and scripts inside the game's folder (and inside workshop mods). To show and dress a character exactly like the game does, the tool has to read those files. To import a character's look, it reads that save's <code>players.db</code>.</p>
        <h4>What it does with them</h4>
        <p>It only <b>reads</b> them, into your browser's memory, to build the thumbnails and render the 3D character. Every step (reading files, converting models, drawing the character, exporting images) happens on your own computer.</p>
        <h4>Why it can't harm your files or your game</h4>
        <p><b>Read-only.</b> The browser only ever grants this page permission to <i>read</i>. It cannot create, write, move, rename or delete anything, and there is no code here that modifies files, so it cannot change or break your game or your saves.</p>
        <p><b>Only the folder you choose.</b> The File System Access API is sandboxed by the browser: the page can see only the exact folder you pick, nothing else on your PC, and only for this tab. The permission isn't remembered, so you grant it again each session.</p>
        <p><b>Nothing is uploaded, and the browser enforces it.</b> There is no server behind this; it's a static page. A strict Content-Security-Policy instructs your browser to block <i>any</i> network request except loading the page's own code, so no game file, save or mod can leave your machine even if there were a bug.</p>
        <p><b>You stay in control.</b> Close the tab and all access ends. The only things kept are small local caches (thumbnails and converted meshes) in your browser's own storage, which you can wipe anytime with the <b>Clear</b> button. They are never sent anywhere.</p>
      </div>
    </details>
  );
}

const TrashIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v5M14 11v5" />
  </svg>
);

// One mod row's label: name on top, author (from mod.info) below. The second line is always
// reserved so rows keep a consistent height whether or not an author is known.
function ModName({ mod }: { mod: DiscoveredMod }) {
  const ellip = { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } as const;
  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontSize: 13, ...ellip }}>{mod.name}</div>
      <div style={{ fontSize: 11, color: 'var(--muted)', minHeight: 14, ...ellip }}>{mod.author ? 'by ' + mod.author : ''}</div>
    </div>
  );
}

// A connected/unconnected folder tile for the Sources card.
function FolderChip({ label, name, connected, warn, action, onAction, disabled, hint }: {
  label: string; name?: string; connected: boolean; warn?: string; action: string; onAction: () => void; disabled?: boolean; hint?: React.ReactNode;
}) {
  return (
    <div style={{ flex: '1 1 240px', minWidth: 220, display: 'flex', alignItems: 'center', gap: 11, background: '#14141a', border: '1px solid var(--line)', borderRadius: 9, padding: '11px 12px' }}>
      <div style={{ width: 30, height: 30, borderRadius: 7, display: 'grid', placeItems: 'center', fontSize: 15, flexShrink: 0, background: connected ? '#1e3a24' : warn ? '#3a3320' : '#20202a', color: connected ? '#5fd07a' : warn ? '#e0c060' : 'var(--muted)' }}>{connected ? '✓' : warn ? '!' : '+'}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
          {label}
          {hint && <span className="infoi">i<span className="tip" onClick={(e) => e.stopPropagation()}>{hint}</span></span>}
        </div>
        <div style={{ fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: warn ? '#e0c060' : 'var(--text)' }}>{warn || name || 'not connected'}</div>
      </div>
      <button className="secondary" onClick={onAction} disabled={disabled} style={{ padding: '5px 11px', fontSize: 12.5, flexShrink: 0 }}>{action}</button>
    </div>
  );
}

function CacheInfo() {
  const [bytes, setBytes] = useState<number | null>(null);
  const [count, setCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => { setBytes(await storageUsage()); setCount(await idbCache.count().catch(() => null)); }, []);
  useEffect(() => { refresh(); }, [refresh]);
  const clear = useCallback(async () => { setBusy(true); await idbCache.clear(); location.reload(); }, []);
  const mb = bytes != null ? (bytes / 1e6).toFixed(1) + ' MB' : 'n/a';
  return (
    <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--line)', color: 'var(--muted)', fontSize: 12.5, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
      <span>Thumbnail cache <b style={{ color: 'var(--text)' }}>{mb}</b>{count != null ? ` · ${count} thumbnails` : ''}</span>
      <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
        <button className="secondary" onClick={refresh} style={{ padding: '4px 10px', fontSize: 12 }}>refresh</button>
        <button className="secondary" onClick={clear} disabled={busy} style={{ padding: '4px 10px', fontSize: 12 }}>{busy ? 'clearing…' : 'Clear'}</button>
      </span>
    </div>
  );
}
