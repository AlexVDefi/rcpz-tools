import { useEffect, useState, useCallback, useMemo } from 'react';
// shared/ domain core — the same modules parity-tested in Node, running in the browser.
import { buildAssetIndex } from '@shared/asset-index.js';
import { listClothing, listClips, listHair, listHeldItems } from '@shared/character-core.js';
import { createFsaAssetSource } from './platform/fsa-source';
import { idbHandles, hasPermission, requestPermission } from './platform/idb';
import { converter } from './render/converter';
import { CharacterViewer } from './CharacterViewer';

const INSTALL_KEY = 'pz-install';
const fsaSupported = typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';

type Phase = 'unsupported' | 'idle' | 'need-permission' | 'scanning' | 'ready' | 'error';
type View = 'overview' | 'character';
interface Counts { clothing: number; clips: number; held: number; hairM: number; hairF: number; beards: number; }

export function App() {
  const [phase, setPhase] = useState<Phase>(fsaSupported ? 'idle' : 'unsupported');
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [counts, setCounts] = useState<Counts | null>(null);
  const [index, setIndex] = useState<unknown>(null);
  const [view, setView] = useState<View>('overview');
  const [savedHandle, setSavedHandle] = useState<FileSystemDirectoryHandle | null>(null);

  // render context shared by the viewers: the parity-tested resolver + the WASM converter
  const ctx = useMemo(() => (index ? { resolver: (index as { resolver: unknown }).resolver, converter } : null), [index]);

  const scan = useCallback(async (handle: FileSystemDirectoryHandle) => {
    setPhase('scanning'); setError('');
    const t0 = performance.now();
    try {
      const source = createFsaAssetSource(handle, { id: 'install', isMod: false });
      const idx = await buildAssetIndex([source], { onProgress: (m: string) => setProgress(m) });
      const clothing = listClothing(idx);
      const { hair, beards } = listHair(idx);
      setCounts({ clothing: clothing.length, clips: listClips(idx).length, held: listHeldItems(idx).length, hairM: hair.male.length, hairF: hair.female.length, beards: beards.length });
      setIndex(idx);
      setProgress(`scanned in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
      setPhase('ready');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('error');
    }
  }, []);

  useEffect(() => {
    if (!fsaSupported) return;
    (async () => {
      const handle = await idbHandles.load(INSTALL_KEY);
      if (!handle) return;
      setSavedHandle(handle);
      if (await hasPermission(handle)) scan(handle);
      else setPhase('need-permission');
    })();
  }, [scan]);

  const pickInstall = useCallback(async () => {
    try {
      const handle = await window.showDirectoryPicker({ id: 'pz-install', mode: 'read' });
      await idbHandles.save(INSTALL_KEY, handle);
      setSavedHandle(handle);
      scan(handle);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError((e as Error).message);
    }
  }, [scan]);

  const reconnect = useCallback(async () => {
    if (!savedHandle) return;
    if (await requestPermission(savedHandle)) scan(savedHandle);
    else setError('Permission denied.');
  }, [savedHandle, scan]);

  return (
    <div style={{ maxWidth: view === 'character' ? 1400 : 960, margin: '0 auto', padding: 24 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <h1 style={{ marginBottom: 4 }}>pz-icon-maker <span style={{ color: 'var(--muted)', fontWeight: 400 }}>· web</span></h1>
        {index != null && (
          <div style={{ display: 'flex', gap: 6 }}>
            {(['overview', 'character'] as const).map((v) => (
              <button key={v} className="secondary" onClick={() => setView(v)}
                style={{ background: view === v ? 'var(--accent)' : 'var(--panel)', color: view === v ? '#fff' : 'var(--text)' }}>
                {v === 'overview' ? 'Overview' : 'Character viewer'}
              </button>
            ))}
          </div>
        )}
      </div>

      {phase === 'unsupported' && (
        <div style={{ background: '#3a2626', border: '1px solid #5a3a3a', borderRadius: 8, padding: 16 }}>
          <strong>This tool needs a Chromium browser.</strong>
          <p style={{ marginBottom: 0 }}>
            Reading files from your PC uses the File System Access API, which only Chrome, Edge, Brave, and Opera
            support. Firefox and Safari can’t run it. Please open this page in one of those.
          </p>
        </div>
      )}

      {phase !== 'unsupported' && index == null && (
        <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 8, padding: 16, marginTop: 12 }}>
          <p style={{ marginTop: 0, color: 'var(--muted)' }}>
            Point the tool at your Project Zomboid install folder (the one containing <code>media/</code>). Nothing is
            uploaded — every file stays on your machine.
          </p>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <button onClick={pickInstall} disabled={phase === 'scanning'}>
              {savedHandle ? 'Choose a different install folder…' : 'Choose your PZ install folder…'}
            </button>
            {phase === 'need-permission' && <button className="secondary" onClick={reconnect}>Reconnect “{savedHandle?.name}”</button>}
            {phase === 'scanning' && progress && <span style={{ color: 'var(--muted)' }}>{progress}</span>}
          </div>
        </div>
      )}

      {error && <p style={{ color: '#ff8a8a' }}>Error: {error}</p>}

      {index != null && view === 'overview' && counts && (
        <div style={{ marginTop: 16 }}>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
            {([['Clothing', counts.clothing], ['Clips', counts.clips], ['Held items', counts.held], ['Hair (M/F)', `${counts.hairM}/${counts.hairF}`], ['Beards', counts.beards]] as const).map(([label, n]) => (
              <div key={label} style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 8, padding: '10px 14px' }}>
                <div style={{ fontSize: 20, fontWeight: 600 }}>{n}</div>
                <div style={{ color: 'var(--muted)', fontSize: 12 }}>{label}</div>
              </div>
            ))}
          </div>
          <p style={{ color: 'var(--muted)' }}>
            {progress}. Open the <b>Character viewer</b> to render an animated character from your install.
            Grid pickers with thumbnails, clothing, and icons are coming next.
          </p>
          <div style={{ display: 'flex', gap: 10 }}>
            <button onClick={() => setView('character')}>Open character viewer →</button>
            <button className="secondary" onClick={pickInstall}>Choose a different folder…</button>
          </div>
        </div>
      )}

      {index != null && view === 'character' && ctx && (
        <div style={{ marginTop: 12 }}>
          <CharacterViewer ctx={ctx} index={index} />
        </div>
      )}
    </div>
  );
}
