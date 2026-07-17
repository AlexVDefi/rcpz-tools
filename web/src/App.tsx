import { useEffect, useState, useCallback } from 'react';
// shared/ domain core — the same modules parity-tested in Node, running in the browser.
import { buildAssetIndex } from '@shared/asset-index.js';
import { listClothing, listClips, listHair, listHeldItems } from '@shared/character-core.js';
import { createFsaAssetSource } from './platform/fsa-source';
import { idbHandles, hasPermission, requestPermission } from './platform/idb';

const INSTALL_KEY = 'pz-install';
const fsaSupported = typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';

type Phase = 'unsupported' | 'idle' | 'need-permission' | 'scanning' | 'ready' | 'error';

interface Counts { clothing: number; clips: number; held: number; hairM: number; hairF: number; beards: number; }

export function App() {
  const [phase, setPhase] = useState<Phase>(fsaSupported ? 'idle' : 'unsupported');
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [counts, setCounts] = useState<Counts | null>(null);
  const [sample, setSample] = useState<Array<{ name: string; kind: string; location: string; isMod: boolean }>>([]);
  const [savedHandle, setSavedHandle] = useState<FileSystemDirectoryHandle | null>(null);

  const scan = useCallback(async (handle: FileSystemDirectoryHandle) => {
    setPhase('scanning'); setError('');
    const t0 = performance.now();
    try {
      const source = createFsaAssetSource(handle, { id: 'install', isMod: false });
      const index = await buildAssetIndex([source], { onProgress: (m: string) => setProgress(m) });
      const clothing = listClothing(index);
      const clips = listClips(index);
      const held = listHeldItems(index);
      const { hair, beards } = listHair(index);
      setCounts({ clothing: clothing.length, clips: clips.length, held: held.length, hairM: hair.male.length, hairF: hair.female.length, beards: beards.length });
      setSample(clothing.slice(0, 60).map((c: { name: string; kind: string; location: string; isMod: boolean }) =>
        ({ name: c.name, kind: c.kind, location: c.location, isMod: c.isMod })));
      setProgress(`scanned in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
      setPhase('ready');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('error');
    }
  }, []);

  // On load: try to restore a previously-picked install folder (permission may need a click).
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
    <div style={{ maxWidth: 960, margin: '0 auto', padding: 24 }}>
      <h1 style={{ marginBottom: 4 }}>pz-icon-maker <span style={{ color: 'var(--muted)', fontWeight: 400 }}>· web</span></h1>
      <p style={{ color: 'var(--muted)', marginTop: 0 }}>
        Render Project Zomboid characters and item icons in your browser, from your own local install.
      </p>

      {phase === 'unsupported' && (
        <div style={{ background: '#3a2626', border: '1px solid #5a3a3a', borderRadius: 8, padding: 16 }}>
          <strong>This tool needs a Chromium browser.</strong>
          <p style={{ marginBottom: 0 }}>
            Reading files from your PC uses the File System Access API, which only Chrome, Edge, Brave, and Opera
            support. Firefox and Safari can’t run it. Please open this page in one of those.
          </p>
        </div>
      )}

      {phase !== 'unsupported' && (
        <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 8, padding: 16 }}>
          <p style={{ marginTop: 0 }}>
            Point the tool at your Project Zomboid install folder (the one containing <code>media/</code>). Nothing is
            uploaded — every file stays on your machine.
          </p>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <button onClick={pickInstall} disabled={phase === 'scanning'}>
              {savedHandle ? 'Choose a different install folder…' : 'Choose your PZ install folder…'}
            </button>
            {phase === 'need-permission' && (
              <button className="secondary" onClick={reconnect}>Reconnect “{savedHandle?.name}”</button>
            )}
            {(phase === 'scanning' || phase === 'ready') && progress && (
              <span style={{ color: 'var(--muted)' }}>{progress}</span>
            )}
          </div>
        </div>
      )}

      {error && <p style={{ color: '#ff8a8a' }}>Error: {error}</p>}

      {counts && (
        <div style={{ marginTop: 20 }}>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
            {[
              ['Clothing', counts.clothing], ['Clips', counts.clips], ['Held items', counts.held],
              ['Hair (M/F)', `${counts.hairM}/${counts.hairF}`], ['Beards', counts.beards],
            ].map(([label, n]) => (
              <div key={label} style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 8, padding: '10px 14px' }}>
                <div style={{ fontSize: 20, fontWeight: 600 }}>{n}</div>
                <div style={{ color: 'var(--muted)', fontSize: 12 }}>{label}</div>
              </div>
            ))}
          </div>
          <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 8, padding: 12, maxHeight: 320, overflow: 'auto' }}>
            <div style={{ color: 'var(--muted)', marginBottom: 6 }}>First {sample.length} clothing items (grid + thumbnails coming next):</div>
            {sample.map((c) => (
              <div key={c.name} style={{ display: 'flex', gap: 8, padding: '2px 0', fontFamily: 'monospace', fontSize: 13 }}>
                <span style={{ color: 'var(--accent)', width: 90 }}>{c.location}</span>
                <span style={{ color: 'var(--muted)', width: 70 }}>{c.kind}</span>
                <span>{c.name}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
