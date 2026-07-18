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
      // enumeration only (reads each mod.info) — no media scan yet, so it's fast. The user
      // then picks which mods to load and hits Apply, so they never wait on mods they don't want.
      const found = await discoverWorkshopMods(h, (n) => setProgress(`found ${n} mods…`));
      setMods(found);
      setProgress(`found ${found.length} mods — pick the ones you want, then Apply & rescan`);
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

  return (
    <div style={{ maxWidth: wide ? 'none' : 980, margin: wide ? 0 : '0 auto', padding: '16px 24px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <h1 style={{ marginBottom: 4 }}>pz-icon-maker <span style={{ color: 'var(--muted)', fontWeight: 400 }}>· web</span></h1>
        {index != null && (
          <div style={{ display: 'flex', gap: 6 }}>
            {(['overview', 'character'] as const).map((v) => (
              <button key={v} className="secondary" onClick={() => setView(v)} style={{ background: view === v ? 'var(--accent)' : 'var(--panel)', color: view === v ? '#fff' : 'var(--text)' }}>
                {v === 'overview' ? 'Overview' : 'Character viewer'}
              </button>
            ))}
          </div>
        )}
      </div>

      {phase === 'unsupported' && (
        <div style={{ background: '#3a2626', border: '1px solid #5a3a3a', borderRadius: 8, padding: 16 }}>
          <strong>This tool needs a Chromium browser.</strong>
          <p style={{ marginBottom: 0 }}>Reading files from your PC uses the File System Access API — only Chrome, Edge, Brave, and Opera support it.</p>
        </div>
      )}

      {phase !== 'unsupported' && view === 'overview' && (
        <div style={{ marginTop: 12, display: 'grid', gap: 12 }}>
          <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 8, padding: 16 }}>
            <p style={{ marginTop: 0, color: 'var(--muted)' }}>
              Point the tool at your Project Zomboid install folder (the one containing <code>media/</code>). Nothing is uploaded.
            </p>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <button onClick={pickInstall} disabled={phase === 'scanning'}>{installHandle ? `Install: ${installHandle.name}` : 'Choose your PZ install folder…'}</button>
              {needPerm && <button className="secondary" onClick={reconnect}>Reconnect “{installHandle?.name}”</button>}
              <button className="secondary" onClick={pickWorkshop} disabled={phase === 'scanning'}>{mods.length ? `Workshop: ${mods.length} mods` : 'Add workshop mods folder…'}</button>
              {phase === 'scanning' && progress && <span style={{ color: 'var(--muted)' }}>{progress}</span>}
              {phase === 'ready' && progress && <span style={{ color: 'var(--muted)' }}>{progress}</span>}
            </div>
            {error && <p style={{ color: '#ff8a8a' }}>Error: {error}</p>}
          </div>

          {mods.length > 0 && (
            <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 8, padding: 16 }}>
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
            <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 8, padding: 16 }}>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
                {([['Clothing', counts.clothing], ['· modded', counts.modClothing], ['Clips', counts.clips], ['Held items', counts.held], ['Hair M/F', `${counts.hairM}/${counts.hairF}`], ['Beards', counts.beards]] as const).map(([label, n]) => (
                  <div key={label} style={{ background: '#14141a', border: '1px solid var(--line)', borderRadius: 8, padding: '10px 14px' }}>
                    <div style={{ fontSize: 20, fontWeight: 600 }}>{n}</div>
                    <div style={{ color: 'var(--muted)', fontSize: 12 }}>{label}</div>
                  </div>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <button onClick={() => setView('character')}>Open character viewer →</button>
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

function CacheInfo() {
  const [bytes, setBytes] = useState<number | null>(null);
  const [count, setCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => { setBytes(await storageUsage()); setCount(await idbCache.count().catch(() => null)); }, []);
  useEffect(() => { refresh(); }, [refresh]);
  const clear = useCallback(async () => { setBusy(true); await idbCache.clear(); location.reload(); }, []);
  const mb = bytes != null ? (bytes / 1e6).toFixed(1) + ' MB' : '—';
  return (
    <div style={{ marginTop: 18, color: 'var(--muted)', fontSize: 13, display: 'flex', gap: 12, alignItems: 'center' }}>
      <span>Thumbnail cache: <b style={{ color: 'var(--text)' }}>{mb}</b>{count != null ? ` · ${count} thumbnails` : ''}</span>
      <button className="secondary" onClick={clear} disabled={busy} style={{ padding: '4px 10px', fontSize: 12 }}>{busy ? 'clearing…' : 'Clear thumbnails'}</button>
      <button className="secondary" onClick={refresh} style={{ padding: '4px 10px', fontSize: 12 }}>refresh</button>
    </div>
  );
}
