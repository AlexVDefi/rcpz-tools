import { useEffect, useState, useCallback, useMemo } from 'react';
import { buildAssetIndex } from '@shared/asset-index.js';
import { listClothing, listClips, listHair, listHeldItems } from '@shared/character-core.js';
import { createFsaAssetSource } from './platform/fsa-source';
import { discoverWorkshopMods, modSources, type DiscoveredMod } from './platform/mod-discovery';
import { idbHandles, idbCache, hasPermission, requestPermission, storageUsage } from './platform/idb';
import { converter } from './render/converter';
import { CharacterViewer } from './CharacterViewer';

const INSTALL_KEY = 'pz-install';
const WORKSHOP_KEY = 'pz-workshop';
const ACTIVE_KEY = 'pz-active-mods';
const fsaSupported = typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';

type Phase = 'unsupported' | 'idle' | 'need-permission' | 'scanning' | 'ready' | 'error';
type View = 'overview' | 'character';
interface Counts { clothing: number; clips: number; held: number; hairM: number; hairF: number; beards: number; modClothing: number; }

export function App() {
  const [phase, setPhase] = useState<Phase>(fsaSupported ? 'idle' : 'unsupported');
  const [progress, setProgress] = useState('');
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

  const rebuild = useCallback(async (installH: FileSystemDirectoryHandle, active: DiscoveredMod[]) => {
    setPhase('scanning'); setError('');
    const t0 = performance.now();
    try {
      const sources = [...modSources(active), createFsaAssetSource(installH, { id: 'install', isMod: false })];
      const idx = await buildAssetIndex(sources, { onProgress: (m: string) => setProgress(m) });
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
  }, []);

  // restore install (+ workshop mods) on load
  useEffect(() => {
    if (!fsaSupported) return;
    (async () => {
      const inst = await idbHandles.load(INSTALL_KEY);
      if (!inst) return;
      setInstallHandle(inst);
      if (!(await hasPermission(inst))) { setNeedPerm(true); return; }
      const ws = await idbHandles.load(WORKSHOP_KEY);
      let discovered: DiscoveredMod[] = [];
      if (ws && await hasPermission(ws)) { discovered = await discoverWorkshopMods(ws); setMods(discovered); }
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
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 38, height: 38, borderRadius: 9, background: 'linear-gradient(135deg,#5b8cff,#9a6bff)', display: 'grid', placeItems: 'center', fontSize: 19, color: '#fff' }}>◈</div>
          <div>
            <div style={{ fontSize: 19, fontWeight: 700, lineHeight: 1.1 }}>PZ Character Studio</div>
            <div style={{ color: 'var(--muted)', fontSize: 12.5 }}>Dress, pose and export your survivors</div>
          </div>
        </div>
        {index != null && (
          <div style={{ display: 'flex', border: '1px solid var(--line)', borderRadius: 8, overflow: 'hidden' }}>
            {(['overview', 'character'] as const).map((v) => (
              <button key={v} className="secondary" onClick={() => setView(v)} style={{ borderRadius: 0, border: 0, background: view === v ? 'var(--accent)' : 'transparent', color: view === v ? '#fff' : 'var(--text)' }}>
                {v === 'overview' ? 'Overview' : 'Character viewer'}
              </button>
            ))}
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
        </section>
      )}

      {phase !== 'unsupported' && view === 'overview' && !firstRun && (
        <div style={{ marginTop: 18, display: 'grid', gap: 14 }}>
          <div className="card">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <b style={{ fontSize: 13 }}>Sources</b>
              {phase === 'scanning' && <span style={{ color: 'var(--muted)', fontSize: 12.5 }}><span className="spinner" /> {progress || 'scanning…'}</span>}
              {phase === 'ready' && progress && <span style={{ color: 'var(--muted)', fontSize: 12.5, marginLeft: 'auto' }}>{progress}</span>}
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <FolderChip label="Game install" name={installHandle?.name} connected={!!installHandle && !needPerm}
                warn={needPerm ? 'reconnect needed' : undefined} action={needPerm ? 'Reconnect' : 'Change'} onAction={needPerm ? reconnect : pickInstall} disabled={phase === 'scanning'} />
              <FolderChip label="Workshop mods" name={mods.length ? `${mods.length} mods found` : undefined} connected={mods.length > 0}
                action={mods.length ? 'Change' : 'Add'} onAction={pickWorkshop} disabled={phase === 'scanning'} />
            </div>
            {error && <p style={{ color: '#ff8a8a', margin: '10px 0 0' }}>Error: {error}</p>}
            <SafetyInfo />
          </div>

          {mods.length > 0 && (
            <div className="card">
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
                <b>Active mods</b>
                <span style={{ color: 'var(--muted)', fontSize: 12 }}>{activeMods.length} of {mods.length} · higher = overrides lower & vanilla</span>
                <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                  <button className="secondary" onClick={addAllMods} disabled={phase === 'scanning'} style={{ padding: '4px 10px', fontSize: 12 }}>Add all</button>
                  <button className="secondary" onClick={clearMods} disabled={phase === 'scanning'} style={{ padding: '4px 10px', fontSize: 12 }}>Clear</button>
                  <button onClick={applyMods} disabled={!installHandle || phase === 'scanning'}>Apply & rescan</button>
                </span>
              </div>
              <div style={{ maxHeight: 220, overflow: 'auto', display: 'grid', gap: 3 }}>
                {activeMods.map((m, i) => (
                  <div key={m.key} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, padding: '2px 4px', background: '#14141a', borderRadius: 5 }}>
                    <span style={{ display: 'flex', gap: 2 }}>
                      <button className="secondary" onClick={() => moveMod(m.key, -1)} disabled={i === 0} style={{ padding: '0 6px' }}>↑</button>
                      <button className="secondary" onClick={() => moveMod(m.key, 1)} disabled={i === activeMods.length - 1} style={{ padding: '0 6px' }}>↓</button>
                    </span>
                    <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.name}</span>
                    <button className="secondary" onClick={() => toggleMod(m.key)} style={{ padding: '2px 8px', fontSize: 12 }}>remove</button>
                  </div>
                ))}
                {!activeMods.length && <span style={{ color: 'var(--muted)', fontSize: 13 }}>No active mods. Add some below.</span>}
              </div>
              {inactiveAll.length > 0 && (
                <>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '10px 0 4px' }}>
                    <span style={{ color: 'var(--muted)', fontSize: 12 }}>Available</span>
                    <input value={modFilter} onChange={(e) => setModFilter(e.target.value)} placeholder="filter mods…"
                      style={{ flex: 1, background: '#14141a', color: 'var(--text)', border: '1px solid var(--line)', borderRadius: 6, padding: '4px 8px', fontSize: 12 }} />
                  </div>
                  <div style={{ maxHeight: 160, overflow: 'auto', display: 'grid', gap: 3 }}>
                    {inactiveMods.map((m) => (
                      <div key={m.key} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, padding: '2px 4px' }}>
                        <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: 'var(--muted)' }}>{m.name}</span>
                        <button className="secondary" onClick={() => toggleMod(m.key)} style={{ padding: '2px 8px', fontSize: 12 }}>+ add</button>
                      </div>
                    ))}
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
              <div style={{ textAlign: 'center', margin: '20px 0 10px' }}>
                <button onClick={() => setView('character')} style={{ padding: '13px 30px', fontSize: 16, fontWeight: 600 }}>Open character viewer →</button>
                <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 8 }}>Your library is ready. Open the viewer to dress and pose a character.</div>
              </div>
              <CacheInfo />
            </div>
          )}
        </div>
      )}

      {index != null && view === 'character' && ctx && (
        <div style={{ marginTop: 12 }}><CharacterViewer ctx={ctx} index={index} /></div>
      )}
    </div>
  );
}

// Plain-language explanation of why the tool reads local files and why that is safe.
function SafetyInfo() {
  return (
    <details className="safety" style={{ marginTop: 12, background: '#14141a', border: '1px solid var(--line)', borderRadius: 9 }}>
      <summary style={{ padding: '11px 13px', fontWeight: 600, fontSize: 13, display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ width: 22, height: 22, borderRadius: 6, background: '#1e3a24', color: '#5fd07a', display: 'grid', placeItems: 'center', fontSize: 12, flexShrink: 0 }}>✓</span>
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

// A connected/unconnected folder tile for the Sources card.
function FolderChip({ label, name, connected, warn, action, onAction, disabled }: {
  label: string; name?: string; connected: boolean; warn?: string; action: string; onAction: () => void; disabled?: boolean;
}) {
  return (
    <div style={{ flex: '1 1 240px', minWidth: 220, display: 'flex', alignItems: 'center', gap: 11, background: '#14141a', border: '1px solid var(--line)', borderRadius: 9, padding: '11px 12px' }}>
      <div style={{ width: 30, height: 30, borderRadius: 7, display: 'grid', placeItems: 'center', fontSize: 15, flexShrink: 0, background: connected ? '#1e3a24' : warn ? '#3a3320' : '#20202a', color: connected ? '#5fd07a' : warn ? '#e0c060' : 'var(--muted)' }}>{connected ? '✓' : warn ? '!' : '+'}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>{label}</div>
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
