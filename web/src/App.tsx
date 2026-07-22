import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { buildAssetIndex } from '@shared/asset-index.js';
import { listClothing, listClips, listHair, listHeldItems } from '@shared/character-core.js';
import { createFsaAssetSource } from './platform/fsa-source';
import { loadHostedSource } from './platform/hosted-source';
import { discoverWorkshopMods, modSources, type DiscoveredMod } from './platform/mod-discovery';
import { idbCache, hasPermission, requestPermission, storageUsage } from './platform/idb';
import { pickDirectory, saveDir, loadDir, fileAccessSupported, isDesktop } from './platform/platform';
import { converter } from './render/converter';
import { CharacterViewer } from './CharacterViewer';
import { SharedGallery } from './SharedGallery';
import { ModderDashboard } from './ModderDashboard';
import { useSteam } from './cloud/steam';
import { fetchHostedMods, type HostedMod } from './cloud/hosted-mods';
import { useAuth, type AuthState } from './cloud/auth';
import { useCloudUploads } from './cloud/uploads';
import { AuthModal } from './cloud/AuthModal';
import { DeleteAccountModal } from './cloud/DeleteAccountModal';
import { PasswordModal } from './cloud/PasswordModal';
import { cloudConfigured } from './cloud/config';
import { listLanguages, loadItemNames, languageLabel, type DisplayNames } from './item-names';
import logoUrl from './assets/logo.png';
import kofiUrl from './assets/kofi_symbol.svg';

const NAV_H = 36; // uniform height for all header controls
const DESKTOP_APP_URL = 'https://github.com/AlexVDefi/rcpz-tools/releases'; // desktop app download
const INSTALL_KEY = 'pz-install';
const WORKSHOP_KEY = 'pz-workshop';
const ACTIVE_KEY = 'pz-active-mods';
const SOURCE_KEY = 'pz-asset-source'; // remembers the last choice: 'local' | 'hosted'
const fsaSupported = fileAccessSupported; // true in the desktop app (native fs) or an FSA-capable browser
// Hosted vanilla asset bundle (baked by tools/bake-assets.mjs, served from R2). When set, the app
// offers a no-install path that works on ANY browser - local files/mods still need Chromium FSA.
const HOSTED_ASSETS_URL = ((import.meta.env.VITE_HOSTED_ASSETS_URL as string) || '').trim();
const hostedAvailable = !!HOSTED_ASSETS_URL;
const usable = fsaSupported || hostedAvailable; // the app is usable if either path is available

type Phase = 'unsupported' | 'idle' | 'need-permission' | 'scanning' | 'ready' | 'error';
type View = 'overview' | 'character' | 'shared' | 'mods';
type ScanStep = 'scripts' | 'clothing' | 'anims';
type Scan = { source: number; total: number; step: ScanStep; count: number; name: string };
const SCAN_STEPS: ScanStep[] = ['scripts', 'clothing', 'anims'];
const STEP_NAME: Record<ScanStep, string> = { scripts: 'Scripts', clothing: 'Clothing', anims: 'Animations' };
const STEP_VERB: Record<ScanStep, string> = { scripts: 'Reading scripts', clothing: 'Reading clothing', anims: 'Indexing animations' };
// Hosted assets are fetched from the CDN, not read off disk - so the loading modal must not claim
// to be "reading your game files" (that wording is kept for the local-install path).
const STEP_VERB_HOSTED: Record<ScanStep, string> = { scripts: 'Loading scripts', clothing: 'Loading clothing', anims: 'Indexing animations' };
interface Counts { clothing: number; clips: number; held: number; hairM: number; hairF: number; beards: number; modClothing: number; }

// Sanity-check a picked folder before scanning it: a real PZ install has a `media` folder that
// itself contains scripts/lua/clothing. Rejects wrong folders (and the `media` folder itself) with
// a clear message instead of silently scanning nothing. Works for both FSA and native handles.
async function looksLikePzInstall(dir: FileSystemDirectoryHandle): Promise<boolean> {
  try {
    let media: FileSystemDirectoryHandle | null = null;
    for await (const e of dir.values()) {
      if (e.kind === 'directory' && e.name.toLowerCase() === 'media') { media = e as FileSystemDirectoryHandle; break; }
    }
    if (!media) return false;
    for await (const e of media.values()) {
      if (e.kind === 'directory' && ['scripts', 'lua', 'clothing'].includes(e.name.toLowerCase())) return true;
    }
    return false;
  } catch { return false; }
}

export function App() {
  const [phase, setPhase] = useState<Phase>(usable ? 'idle' : 'unsupported');
  const [assetSource, setAssetSource] = useState<'local' | 'hosted' | null>(null); // which path built the current index
  const [hostedMods, setHostedMods] = useState<HostedMod[]>([]); // community mods available to layer over hosted vanilla
  const [enabledMods, setEnabledMods] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem('pz-enabled-mods') || '[]'); } catch { return []; } });
  const [progress, setProgress] = useState('');
  const [scan, setScan] = useState<Scan | null>(null);
  const [overlay, setOverlay] = useState<'in' | 'out' | null>(null); // scan modal: fading in, fading out, or gone
  const [scanHosted, setScanHosted] = useState(false); // the in-progress load is hosted assets (CDN), not local files
  const [charName, setCharName] = useState<string | null>(null); // name of the loaded saved character
  const [error, setError] = useState('');
  const [counts, setCounts] = useState<Counts | null>(null);
  const [index, setIndex] = useState<unknown>(null);
  const [view, setView] = useState<View>('overview');
  const [installHandle, setInstallHandle] = useState<FileSystemDirectoryHandle | null>(null);
  const [needPerm, setNeedPerm] = useState(false);
  const [mods, setMods] = useState<DiscoveredMod[]>([]);
  const [activeKeys, setActiveKeys] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem(ACTIVE_KEY) || '[]'); } catch { return []; } });
  const auth = useAuth();
  const steam = useSteam();
  // Land on the Mods view right after returning from Steam sign-in.
  useEffect(() => { if (steam.justArrived) setView('mods'); }, [steam.justArrived]);
  const [authOpen, setAuthOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [changePwOpen, setChangePwOpen] = useState(false);
  const uploads = useCloudUploads(auth.session);
  // the Shared tab only exists while signed in - if the session ends (sign out / account deleted)
  // while it's open, fall back to the overview.
  useEffect(() => { if (view === 'shared' && auth.ready && !auth.user) setView('overview'); }, [view, auth.ready, auth.user]);

  // ---- item display-name translations (item names only, not the whole UI) ----
  const [itemLang, setItemLang] = useState('EN');
  const [langs, setLangs] = useState<string[]>([]);
  const [displayNames, setDisplayNames] = useState<DisplayNames | null>(null);
  const [langLoading, setLangLoading] = useState(false);
  // discover which languages the current sources offer (cheap: dir listings only). Runs on rescan.
  useEffect(() => {
    if (!index) { setLangs([]); setDisplayNames(null); return; }
    let live = true;
    listLanguages(index)
      .then((ls) => { if (!live) return; setLangs(ls); if (!ls.includes(itemLang)) setItemLang('EN'); })
      .catch(() => { if (live) setLangs([]); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);
  // load the chosen language's ItemName files (English by default; other languages only when picked).
  useEffect(() => {
    if (!index) return;
    let live = true;
    setLangLoading(true);
    loadItemNames(index, itemLang)
      .then((dn) => { if (live) setDisplayNames(dn); })
      .catch(() => { if (live) setDisplayNames(null); })
      .finally(() => { if (live) setLangLoading(false); });
    return () => { live = false; };
  }, [index, itemLang]);

  const ctx = useMemo(() => (index ? { resolver: (index as { resolver: unknown }).resolver, converter } : null), [index]);
  const activeMods = useMemo(() => activeKeys.map((k) => mods.find((m) => m.key === k)).filter(Boolean) as DiscoveredMod[], [activeKeys, mods]);
  useEffect(() => { localStorage.setItem(ACTIVE_KEY, JSON.stringify(activeKeys)); }, [activeKeys]);

  const fadeTimer = useRef<number | null>(null);
  const rebuild = useCallback(async (installH: FileSystemDirectoryHandle, active: DiscoveredMod[]) => {
    // show the scan overlay in the SAME render as phase='scanning' (batched), so it's the first
    // thing on screen - no flash of the empty Sources card before the modal appears.
    if (fadeTimer.current) { clearTimeout(fadeTimer.current); fadeTimer.current = null; }
    setPhase('scanning'); setOverlay('in'); setError(''); setScanHosted(false);
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
      setAssetSource('local'); localStorage.setItem(SOURCE_KEY, 'local');
      setProgress(`scanned ${sources.length} root${sources.length === 1 ? '' : 's'} in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
      setPhase('ready');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setPhase('error'); }
    finally {
      // fade the modal out (revealing the cards behind it) once the scan settles
      setOverlay('out');
      fadeTimer.current = window.setTimeout(() => { setOverlay(null); setScan(null); fadeTimer.current = null; }, 480);
    }
  }, []);

  // Load a hosted asset bundle (tools/bake-assets.mjs) instead of a local install. Produces
  // the same index the FSA path does, so the rest of the app is unchanged. Reached via
  // ?assets=<baseUrl> for now; becomes the no-install default once R2-hosted.
  const rebuildHosted = useCallback(async (baseUrl: string, mods: HostedMod[] = []) => {
    if (fadeTimer.current) { clearTimeout(fadeTimer.current); fadeTimer.current = null; }
    setPhase('scanning'); setOverlay('in'); setError(''); setScanHosted(true);
    const t0 = performance.now();
    try {
      const { source: vanilla, manifest } = await loadHostedSource(baseUrl, { id: 'hosted' });
      // Each enabled community mod is a higher-priority source layered over vanilla (mods override).
      const modSources = [];
      for (const m of mods) {
        try { const { source } = await loadHostedSource(m.url, { id: `hostedmod:${m.modId}` }); modSources.push(source); }
        catch { /* a mod bundle that fails to load is skipped, not fatal */ }
      }
      const idx = await buildAssetIndex([...modSources, vanilla], { onProgress: (p: Scan) => setScan(p) });
      const clothing = listClothing(idx);
      const { hair, beards } = listHair(idx);
      setCounts({
        clothing: clothing.length, clips: listClips(idx).length, held: listHeldItems(idx).length,
        hairM: hair.male.length, hairF: hair.female.length, beards: beards.length,
        modClothing: clothing.filter((c: { isMod: boolean }) => c.isMod).length,
      });
      setIndex(idx);
      setAssetSource('hosted'); localStorage.setItem(SOURCE_KEY, 'hosted');
      setInstallHandle(null); setMods([]);
      setProgress(`built-in assets${modSources.length ? ` + ${modSources.length} mod${modSources.length === 1 ? '' : 's'}` : ''} (${manifest.version}) in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
      setPhase('ready');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setPhase('error'); }
    finally {
      setOverlay('out');
      fadeTimer.current = window.setTimeout(() => { setOverlay(null); setScan(null); fadeTimer.current = null; }, 480);
    }
  }, []);

  // Load the configured hosted bundle (the "Start now" / "built-in assets" path).
  const useHosted = useCallback(() => {
    if (HOSTED_ASSETS_URL) rebuildHosted(HOSTED_ASSETS_URL, hostedMods.filter((m) => enabledMods.includes(m.modId)));
  }, [rebuildHosted, hostedMods, enabledMods]);
  // Enable/disable a community mod: persist the choice and, if we're on hosted assets, re-layer now.
  const toggleHostedMod = useCallback((modId: string) => {
    const next = enabledMods.includes(modId) ? enabledMods.filter((x) => x !== modId) : [...enabledMods, modId];
    setEnabledMods(next); localStorage.setItem('pz-enabled-mods', JSON.stringify(next));
    if (assetSource === 'hosted' && HOSTED_ASSETS_URL) rebuildHosted(HOSTED_ASSETS_URL, hostedMods.filter((m) => next.includes(m.modId)));
  }, [enabledMods, hostedMods, assetSource, rebuildHosted]);
  // Fetch the community mods available to layer, once, when a hosted bundle is configured.
  useEffect(() => { if (hostedAvailable) fetchHostedMods().then(setHostedMods).catch(() => {}); }, []);

  // ?assets=<baseUrl> loads a hosted bundle (dev/validation override; prod uses HOSTED_ASSETS_URL).
  useEffect(() => {
    const url = new URLSearchParams(window.location.search).get('assets');
    if (url) rebuildHosted(url);
  }, [rebuildHosted]);

  // Restore the last session on load: a granted local install (Chromium), else the hosted
  // bundle if that was the last choice. First-time visitors get the source-choice screen.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('assets')) return; // ?assets= effect owns this load
    (async () => {
      if (fsaSupported) {
        const inst = await loadDir(INSTALL_KEY);
        if (inst) {
          if (!(await hasPermission(inst))) { setInstallHandle(inst); setNeedPerm(true); return; }
          // Committed to a scan: set the handle AND raise the modal in one batched render, so the
          // Sources card and the modal appear on the same frame (no sources-without-modal flash),
          // and the modal covers mod discovery (reading every mod.info) as well as the rebuild.
          setInstallHandle(inst); setPhase('scanning'); setOverlay('in');
          let discovered: DiscoveredMod[] = [];
          try {
            const ws = await loadDir(WORKSHOP_KEY);
            if (ws && await hasPermission(ws)) { discovered = await discoverWorkshopMods(ws); setMods(discovered); }
          } catch { /* discovery is best-effort; fall through to a vanilla rebuild so the modal never sticks */ }
          const active = JSON.parse(localStorage.getItem(ACTIVE_KEY) || '[]').map((k: string) => discovered.find((m) => m.key === k)).filter(Boolean) as DiscoveredMod[];
          rebuild(inst, active);
          return;
        }
      }
      if (hostedAvailable && localStorage.getItem(SOURCE_KEY) === 'hosted') useHosted(); // returning hosted user
    })();
  }, [rebuild, useHosted]);

  const pickInstall = useCallback(async () => {
    try {
      const h = await pickDirectory('pz-install');
      if (!h) return; // cancelled
      if (!(await looksLikePzInstall(h))) {
        setError(`"${h.name}" is not a Project Zomboid install. Pick the folder that contains the "media" folder - e.g. …\\steamapps\\common\\ProjectZomboid.`);
        return;
      }
      setError('');
      await saveDir(INSTALL_KEY, h); setInstallHandle(h); setNeedPerm(false);
      rebuild(h, activeMods);
    } catch (e) { setError((e as Error).message); }
  }, [rebuild, activeMods]);

  const reconnect = useCallback(async () => {
    if (!installHandle) return;
    if (await requestPermission(installHandle)) { setNeedPerm(false); rebuild(installHandle, activeMods); }
    else setError('Permission denied.');
  }, [installHandle, rebuild, activeMods]);

  const pickWorkshop = useCallback(async () => {
    try {
      const h = await pickDirectory('pz-workshop');
      if (!h) return; // cancelled
      await saveDir(WORKSHOP_KEY, h);
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
          <img src={logoUrl} alt="PZ Survivor Studio" width={38} height={38} style={{ width: 38, height: 38, borderRadius: 9, objectFit: 'cover', display: 'block', border: '1px solid var(--line)' }} />
          <div>
            <div style={{ fontSize: 19, fontWeight: 700, lineHeight: 1.1 }}>PZ Survivor Studio</div>
            <div style={{ color: 'var(--muted)', fontSize: 12.5 }}>Dress, pose and export your survivors</div>
          </div>
        </div>
        {charName && <div title="Loaded character" style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', fontSize: 23, fontWeight: 600, color: 'var(--text)', pointerEvents: 'none', whiteSpace: 'nowrap', maxWidth: '40%', overflow: 'hidden', textOverflow: 'ellipsis' }}>{charName}</div>}
        {(index != null || auth.configured || steam.configured) && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {(index != null || auth.user || steam.token) && view !== 'overview' && (
              <button className="secondary" onClick={() => setView('overview')} style={{ height: NAV_H, padding: '0 14px' }}>Overview</button>
            )}
            {index != null && view !== 'character' && (
              <button onClick={() => setView('character')} style={{ height: NAV_H, padding: '0 18px', fontWeight: 600, boxShadow: '0 2px 10px #5b8cff55' }}>Character viewer →</button>
            )}
            {auth.user && (
              <button className="secondary" onClick={() => setView('shared')} style={{ height: NAV_H, padding: '0 14px', borderColor: view === 'shared' ? 'var(--accent)' : 'var(--line)', color: view === 'shared' ? '#fff' : 'var(--text)' }}>Shared</button>
            )}
            {steam.configured && view !== 'mods' && (
              <button className="secondary" onClick={() => setView('mods')} title="Host your Workshop mods" style={{ height: NAV_H, padding: '0 14px' }}>Mods</button>
            )}
            {auth.configured && <AccountChip auth={auth} onSignIn={() => setAuthOpen(true)} onChangePassword={() => setChangePwOpen(true)} onDeleteAccount={() => setDeleteOpen(true)} />}
            {index != null && langs.length > 1 && <LanguageSelect langs={langs} value={itemLang} onChange={setItemLang} loading={langLoading} />}
            <HelpButton />
          </div>
        )}
      </header>

      {authOpen && <AuthModal auth={auth} onClose={() => setAuthOpen(false)} />}
      {deleteOpen && auth.user && (
        <DeleteAccountModal auth={auth} uploads={uploads} onClose={() => setDeleteOpen(false)}
          onDeleted={() => { setDeleteOpen(false); setView('overview'); }} />
      )}
      {changePwOpen && auth.user && <PasswordModal auth={auth} mode="change" onClose={() => setChangePwOpen(false)} />}
      {auth.recovery && <PasswordModal auth={auth} mode="recovery" onClose={() => { /* clearRecovery handled inside */ }} />}

      {phase === 'unsupported' && (
        <div className="card" style={{ marginTop: 40, maxWidth: 560, marginInline: 'auto', textAlign: 'center', background: '#2c2226', borderColor: '#5a3a3a' }}>
          <div style={{ fontSize: 30, marginBottom: 8 }}>◈</div>
          <strong style={{ fontSize: 16 }}>This tool needs a Chromium browser</strong>
          <p style={{ color: 'var(--muted)', margin: '8px 0 0' }}>Reading files from your PC uses the File System Access API, supported only by Chrome, Edge, Brave and Opera.</p>
        </div>
      )}

      {phase !== 'unsupported' && view === 'overview' && firstRun && (
        <section style={{ marginTop: 40, maxWidth: 760, marginInline: 'auto' }}>
          <div style={{ textAlign: 'center', marginBottom: 26 }}>
            <h2 style={{ fontSize: 26, margin: '0 0 12px', lineHeight: 1.2 }}>Bring your survivors to life in the browser</h2>
            <p style={{ color: 'var(--muted)', fontSize: 15, lineHeight: 1.6, margin: 0 }}>
              Browse every outfit, weapon and animation, dress and pose a character, and export stills, GIFs or MP4s. Choose how to load the game's assets.
            </p>
          </div>
          {/* Two balanced cards: same title + pitch + button + one footer line each, equal height. */}
          <div style={{ display: 'grid', gap: 14, alignItems: 'stretch', gridTemplateColumns: hostedAvailable && fsaSupported ? 'repeat(auto-fit, minmax(290px, 1fr))' : '1fr' }}>
            {hostedAvailable && (
              <div className="card" style={{ display: 'flex', flexDirection: 'column', textAlign: 'left' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <b style={{ fontSize: 15.5 }}>Use the built-in assets</b>
                  <span style={{ background: 'var(--accent)', color: '#fff', fontSize: 10.5, fontWeight: 600, borderRadius: 999, padding: '2px 8px', letterSpacing: 0.3 }}>NO SETUP</span>
                </div>
                <p style={{ color: 'var(--muted)', fontSize: 13.5, lineHeight: 1.6, margin: '9px 0 16px', flex: 1 }}>
                  Start right away with the vanilla Project Zomboid assets, hosted online. No download, works on any device - phones and non-Chromium browsers included.
                </p>
                <button onClick={useHosted} style={{ padding: '10px 18px', fontSize: 14.5 }}>Start now</button>
                <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 8 }}>Nothing to install, no file permissions to grant.</div>
              </div>
            )}
            {fsaSupported && (
              <div className="card" style={{ display: 'flex', flexDirection: 'column', textAlign: 'left' }}>
                <b style={{ fontSize: 15.5 }}>Use my own game files</b>
                <p style={{ color: 'var(--muted)', fontSize: 13.5, lineHeight: 1.6, margin: '9px 0 16px', flex: 1 }}>
                  Load vanilla assets from your own Project Zomboid install, and pick up your installed <b>mods</b> too. Modded content is only available this way{isDesktop ? '' : ', and needs a Chromium browser'}.
                </p>
                <button className={hostedAvailable ? 'secondary' : ''} onClick={pickInstall} style={{ padding: '10px 18px', fontSize: 14.5 }}>Choose install folder…</button>
                <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 8 }}>The folder that contains <code>media/</code>.</div>
              </div>
            )}
          </div>
          {hostedAvailable && !fsaSupported && (
            <p style={{ color: 'var(--muted)', fontSize: 12.5, textAlign: 'center', marginTop: 14 }}>
              Want to use your own game files or mods? Open this on a desktop in a Chromium browser (Chrome, Edge, Brave, Opera).
            </p>
          )}
          {/* Local-path details, grouped and clearly scoped: none of it applies to the built-in assets. */}
          {fsaSupported && (
            <div style={{ marginTop: 18, border: '1px solid var(--line)', borderRadius: 10, background: '#101014', padding: '13px 14px 15px' }}>
              {hostedAvailable && (
                <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.55 }}>
                  <b style={{ color: 'var(--text)', fontSize: 13 }}>Using your own game files?</b> Worth knowing before you do. The <b style={{ color: 'var(--text)' }}>built-in assets need none of this</b> - you'd only point at your own install to include <b style={{ color: 'var(--text)' }}>mods</b>.
                </div>
              )}
              <SafetyInfo />
              {/* the desktop app reads any folder natively, so the browser-only C:\Program Files help is web-only */}
              {!isDesktop && <div style={{ marginTop: 8 }}><ProgramFilesHelp /></div>}
            </div>
          )}
          {error && <p style={{ color: '#ff8a8a', marginTop: 18, textAlign: 'center' }}>Error: {error}</p>}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center', marginTop: 26 }}>
            {['Grids & thumbnails', 'Dress, pose & animate', 'Import from a save', 'Export PNG / GIF / MP4'].map((f) => (
              <span key={f} style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 999, padding: '6px 13px', fontSize: 12.5, color: 'var(--muted)' }}>{f}</span>
            ))}
          </div>
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
            {assetSource === 'hosted' ? (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                  <div style={{ flex: 1, minWidth: 240 }}>
                    <div style={{ fontWeight: 600, fontSize: 13.5, display: 'flex', alignItems: 'center', gap: 7 }}>
                      <span style={{ width: 8, height: 8, borderRadius: 999, background: '#4ac07a', display: 'inline-block' }} />
                      Built-in vanilla assets
                    </div>
                    <div style={{ color: 'var(--muted)', fontSize: 12.5, marginTop: 4 }}>
                      Loaded from the hosted library, no game install needed.{fsaSupported ? ' Use your own game files for any mod not listed below.' : ''}
                    </div>
                  </div>
                  {fsaSupported && <button className="secondary" onClick={pickInstall} disabled={phase === 'scanning'} style={{ padding: '7px 13px', fontSize: 12.5 }}>Use my game files instead</button>}
                </div>
                {hostedMods.length > 0 && (
                  <div style={{ marginTop: 14, borderTop: '1px solid var(--line)', paddingTop: 12 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 10 }}>Community mods <span style={{ color: 'var(--muted)', fontWeight: 400 }}>· hosted by their creators, no install needed</span></div>
                    <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fill, minmax(168px, 1fr))' }}>
                      {hostedMods.map((m) => {
                        const on = enabledMods.includes(m.modId);
                        return (
                          <label key={m.modId} className="card" style={{ padding: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', cursor: phase === 'scanning' ? 'wait' : 'pointer', borderColor: on ? 'var(--accent)' : 'var(--line)' }}>
                            <div style={{ position: 'relative', aspectRatio: '16 / 9', background: '#0e0e12' }}>
                              {m.preview
                                ? <img src={m.preview} alt="" loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                                : <div style={{ width: '100%', height: '100%', display: 'grid', placeItems: 'center', color: '#3a3a44' }}>◈</div>}
                              <input type="checkbox" checked={on} disabled={phase === 'scanning'} onChange={() => toggleHostedMod(m.modId)}
                                style={{ position: 'absolute', top: 8, left: 8, width: 17, height: 17, accentColor: 'var(--accent)' }} />
                            </div>
                            <div style={{ padding: '8px 10px 10px' }}>
                              <div style={{ fontSize: 12.5, fontWeight: 600, lineHeight: 1.3, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{m.title}</div>
                              {m.author && <div style={{ color: 'var(--muted)', fontSize: 11.5, marginTop: 3 }}>by {m.author}</div>}
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  <FolderChip label="Game install" name={installHandle?.name} connected={!!installHandle && !needPerm}
                    warn={needPerm ? 'reconnect needed' : undefined} action={needPerm ? 'Reconnect' : 'Change'} onAction={needPerm ? reconnect : pickInstall} disabled={phase === 'scanning'}
                    hint={<>The Project Zomboid install folder, which contains a <b>media</b> folder. On Steam: right-click <b>Project Zomboid</b> → <b>Manage</b> → <b>Browse local files</b>. Typical path: <code>Steam\steamapps\common\ProjectZomboid</code>.</>} />
                  <FolderChip label="Mods" name={mods.length ? `${mods.length} mods found` : undefined} connected={mods.length > 0}
                    action={mods.length ? 'Change' : 'Add'} onAction={pickWorkshop} disabled={phase === 'scanning'}
                    hint={<>Point at any mods folder and it works out the layout: your Steam Workshop content (<code>steamapps\workshop\content\108600</code>), your <code>Zomboid\mods</code>, or <code>Zomboid\Workshop</code> - or the <code>Zomboid</code> folder to get both. Optional, only needed for modded content.</>} />
                </div>
                {hostedAvailable && <button className="secondary" onClick={useHosted} disabled={phase === 'scanning'} style={{ marginTop: 10, padding: '6px 12px', fontSize: 12.5 }}>Switch to built-in assets (no install needed)</button>}
              </>
            )}
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
        <div style={{ marginTop: 12 }}><CharacterViewer ctx={ctx} index={index} onCharacterName={setCharName} auth={auth} onRequestSignIn={() => setAuthOpen(true)} uploads={uploads} displayNames={displayNames} /></div>
      )}

      {view === 'shared' && auth.user && <SharedGallery uploads={uploads} />}

      {view === 'mods' && steam.configured && <ModderDashboard steam={steam} />}

      <div className="credit">
        <a className="watermark" href="https://steamcommunity.com/id/mreastman/myworkshopfiles/?appid=108600"
          target="_blank" rel="noopener noreferrer" title="RedChili on the Steam Workshop">Made by RedChili</a>
        <a className="kofi-link" href="https://ko-fi.com/redchili" target="_blank" rel="noopener noreferrer"
          title="Support RedChili on Ko-fi" aria-label="Support RedChili on Ko-fi">
          <img src={kofiUrl} alt="" />
        </a>
      </div>

      {overlay && <ScanOverlay scan={scan} closing={overlay === 'out'} hosted={scanHosted} />}
    </div>
  );
}

// Help / support popover: a question-mark button that reveals how to get in touch (email + Discord).
function HelpButton() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('mousedown', onDoc);
    return () => window.removeEventListener('mousedown', onDoc);
  }, [open]);
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button className="secondary" title="Help & support" aria-label="Help and support" onClick={() => setOpen((v) => !v)}
        style={{ display: 'grid', placeItems: 'center', width: NAV_H, height: NAV_H, padding: 0, background: open ? 'var(--accent)' : 'var(--panel)', color: open ? '#fff' : 'var(--text)' }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9" /><path d="M9.6 9.4a2.4 2.4 0 0 1 4.4 1.3c0 1.6-2 1.7-2.4 3.1" /><path d="M12 17.1h.01" />
        </svg>
      </button>
      {open && (
        <div style={{ position: 'absolute', right: 0, top: 'calc(100% + 6px)', width: 288, background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 10, padding: 14, zIndex: 130, boxShadow: '0 14px 40px #000000aa' }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>Help &amp; feedback</div>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.6 }}>
            Having issues or want to give some feedback? Email me at <a href="mailto:alexredchili@gmail.com">alexredchili@gmail.com</a> or join my Discord.
          </div>
          <a href="https://discord.gg/EEd2QdyYX" target="_blank" rel="noopener noreferrer"
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 12, padding: '9px 12px', borderRadius: 8, background: '#5865F2', color: '#fff', fontWeight: 600, fontSize: 13, textDecoration: 'none' }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19.27 5.33A16.7 16.7 0 0 0 15 4l-.2.4c1.9.46 2.78 1.13 3.7 1.96A15.6 15.6 0 0 0 12 5c-2.28 0-4.4.5-6.5 1.36.92-.83 1.96-1.55 3.7-1.96L9 4a16.7 16.7 0 0 0-4.27 1.33C2.36 8.82 1.6 12.75 2 16.63a16.9 16.9 0 0 0 5.06 2.56l.6-.83c-.55-.2-1.06-.45-1.55-.75l.38-.28a11.6 11.6 0 0 0 11.02 0l.38.28c-.49.3-1 .55-1.55.75l.6.83A16.7 16.7 0 0 0 22 16.63c.46-4.5-.73-8.4-2.73-11.3ZM8.9 14.66c-.98 0-1.79-.9-1.79-2s.79-2.02 1.79-2.02 1.8.91 1.79 2.02c0 1.1-.8 2-1.79 2Zm6.2 0c-.98 0-1.79-.9-1.79-2s.79-2.02 1.79-2.02 1.8.91 1.79 2.02c0 1.1-.79 2-1.79 2Z" /></svg>
            Join the Discord
          </a>
        </div>
      )}
    </div>
  );
}

// Picks the language used for item/clothing NAMES only (not the whole UI). English by default;
// other languages' translation files are read on demand when picked. Lives to the right of the
// account control.
function LanguageSelect({ langs, value, onChange, loading }: { langs: string[]; value: string; onChange: (l: string) => void; loading: boolean }) {
  const label = languageLabel(value);
  const selFont = { fontSize: 12.5, fontFamily: 'inherit', fontWeight: 400 } as const;
  // A native <select> sizes to its WIDEST option. Measure the SELECTED label instead so the control
  // shrinks to fit the current language (+ room for the dropdown arrow).
  const sizerRef = useRef<HTMLSpanElement>(null);
  const [selW, setSelW] = useState<number>();
  useEffect(() => { if (sizerRef.current) setSelW(sizerRef.current.offsetWidth); }, [label]);
  return (
    <div title="Language for item and clothing names only. It does not change the app's language." style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 6, background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 8, height: NAV_H, padding: '0 8px' }}>
      {loading
        ? <span className="spinner" />
        : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" strokeWidth={1.8} aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.5 3.8 5.7 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.7-3.8-9S9.5 5.5 12 3z" /></svg>}
      {/* the always-visible "Item names" label makes the scope obvious - this is NOT the app language */}
      <span style={{ fontSize: 11.5, color: 'var(--muted)', whiteSpace: 'nowrap' }}>Item names</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} title="Language for item and clothing names only. It does not change the app's language."
        style={{ background: 'transparent', color: 'var(--text)', border: 0, cursor: 'pointer', ...selFont, width: selW != null ? selW + 22 : 'auto' }}>
        {langs.map((l) => <option key={l} value={l} style={{ background: 'var(--panel)' }}>{languageLabel(l)}</option>)}
      </select>
      {/* hidden sizer: same font as the select, measured to width the control to the selected label */}
      <span ref={sizerRef} aria-hidden style={{ position: 'absolute', left: -9999, top: 0, visibility: 'hidden', whiteSpace: 'nowrap', ...selFont }}>{label}</span>
    </div>
  );
}

// Header account control for the optional online feature: a Sign in button when logged out, or
// the signed-in email as a small menu (Sign out / Delete account) when logged in.
function AccountChip({ auth, onSignIn, onChangePassword, onDeleteAccount }: { auth: AuthState; onSignIn: () => void; onChangePassword: () => void; onDeleteAccount: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('mousedown', onDoc);
    return () => window.removeEventListener('mousedown', onDoc);
  }, [open]);
  if (!auth.ready) return null;
  if (!auth.user) return <button className="secondary" onClick={onSignIn} style={{ height: NAV_H, padding: '0 12px', fontSize: 13 }}>Sign in (Optional)</button>;
  const email = auth.user.email || 'account';
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button className="secondary" onClick={() => setOpen((v) => !v)} title="Account"
        style={{ display: 'flex', alignItems: 'center', gap: 7, height: NAV_H, padding: '0 10px', maxWidth: 190 }}>
        <span title={email} style={{ fontSize: 12.5, color: 'var(--text)', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{email}</span>
        <span style={{ color: 'var(--muted)', fontSize: 10 }}>▾</span>
      </button>
      {open && (
        <div style={{ position: 'absolute', right: 0, top: 'calc(100% + 6px)', width: 210, background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 9, padding: 6, zIndex: 120, boxShadow: '0 14px 40px #000000aa' }}>
          <button className="secondary" onClick={() => { setOpen(false); onChangePassword(); }} style={{ width: '100%', textAlign: 'left', padding: '8px 10px', border: 0, background: 'transparent' }}>Change password…</button>
          <button className="secondary" onClick={() => { setOpen(false); auth.signOut(); }} style={{ width: '100%', textAlign: 'left', padding: '8px 10px', border: 0, background: 'transparent' }}>Sign out</button>
          <div style={{ height: 1, background: 'var(--line)', margin: '4px 0' }} />
          <button className="secondary" onClick={() => { setOpen(false); onDeleteAccount(); }} title="Permanently delete your account and shared items"
            style={{ width: '100%', textAlign: 'left', padding: '8px 10px', border: 0, background: 'transparent', color: '#ff8a8a' }}>Delete account…</button>
        </div>
      )}
    </div>
  );
}

// Full-screen scanning modal: blurs the page behind it, shows a live progress bar + step chips,
// then fades out to reveal the freshly-scanned library.
function ScanOverlay({ scan, closing, hosted }: { scan: Scan | null; closing: boolean; hosted: boolean }) {
  const stepIdx = scan ? SCAN_STEPS.indexOf(scan.step) : 0;
  // scan === null is the "preparing" window (discovering mods, before per-source progress
  // reports start): show a small shimmering bar, not a full one that reads as done/stuck.
  const pct = closing ? 100 : !scan ? 6 : Math.min(99, Math.round(((scan.source - 1) * 3 + stepIdx + 1) / (scan.total * 3) * 100));
  const verbs = hosted ? STEP_VERB_HOSTED : STEP_VERB;
  // Hosted: the vanilla source reports its name as "Game install"; relabel it, and name mod sources.
  const sub = !scan ? 'Preparing…'
    : hosted ? (scan.name && scan.name !== 'Game install' ? `Mod: ${scan.name}` : 'Built-in library')
    : `Source ${scan.source} of ${scan.total} · ${scan.name}`;
  return (
    <div className={'scan-overlay' + (closing ? ' closing' : '')} role="status" aria-live="polite">
      <div className="scan-card">
        <img src={logoUrl} className="scan-logo" width={54} height={54} alt="" />
        <div className="scan-title">{closing ? 'Ready' : hosted ? 'Loading the built-in assets' : 'Scanning your game files'}</div>
        <div className="scan-sub">{sub}</div>
        <div className="scan-bar"><div className="scan-bar-fill" style={{ width: pct + '%' }} /></div>
        <div className="scan-steps">
          {SCAN_STEPS.map((st, i) => (
            <div key={st} className={'scan-step' + (closing || i < stepIdx ? ' done' : i === stepIdx ? ' active' : '')}>
              <span className="scan-step-dot" />{STEP_NAME[st]}
            </div>
          ))}
        </div>
        <div className="scan-detail">{scan && !closing ? <>{verbs[scan.step]}… <b>{scan.count.toLocaleString()}</b> found</> : 'Building your library…'}</div>
      </div>
    </div>
  );
}

// Guidance for the common "can't open this folder because it contains system files" error: the
// browser refuses to read C:\Program Files, so we point people at the desktop app, which doesn't
// have that restriction. Web-only (the desktop app hides this).
function ProgramFilesHelp() {
  const code = { background: '#00000066', padding: '1px 5px', borderRadius: 4, fontSize: 12 } as const;
  return (
    <details className="safety" style={{ background: '#14141a', border: '1px solid var(--line)', borderRadius: 9 }}>
      <summary style={{ padding: '11px 13px', fontWeight: 600, fontSize: 13, display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ width: 22, height: 22, borderRadius: 6, background: '#3a3320', color: '#e0c060', display: 'grid', placeItems: 'center', flexShrink: 0, fontWeight: 700 }}>!</span>
        Game on your C: drive? Getting a "contains system files" error?
        <span className="chev" style={{ marginLeft: 'auto', color: 'var(--muted)' }}>▾</span>
      </summary>
      <div style={{ padding: '2px 14px 14px', color: 'var(--muted)', fontSize: 13, lineHeight: 1.6 }}>
        <p>That message comes from your browser, not this tool: for security, browsers won't let web pages read <code style={code}>C:\Program Files</code> (Steam's default location), and they can't override it.</p>
        <p style={{ margin: '10px 0 0' }}>The easy fix is the free <b style={{ color: 'var(--text)' }}>desktop app</b> - the exact same PZ Survivor Studio, installed on your PC. It uses Windows' normal file access instead of the browser's, so it opens your game <b>anywhere, including <code style={code}>C:\Program Files</code></b>, with nothing else to set up.</p>
        <a href={DESKTOP_APP_URL} target="_blank" rel="noopener noreferrer"
          style={{ display: 'inline-block', marginTop: 12, padding: '9px 16px', borderRadius: 8, background: 'var(--accent)', color: '#fff', fontWeight: 600, fontSize: 13, textDecoration: 'none' }}>Download the desktop app →</a>
        <p style={{ margin: '12px 0 0', fontSize: 12.5 }}>It's just as safe: the same tool, it only <b>reads</b> your game files to display them, everything runs on your own machine, and nothing is uploaded unless you choose to share a render. On first launch Windows may say the publisher is unknown (the app isn't code-signed, which is normal for small free tools) - click <b>More info → Run anyway</b>.</p>
      </div>
    </details>
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
        {isDesktop ? (
          <>
            <h4>Why it needs your files</h4>
            <p>Project Zomboid stores its characters as 3D models, textures and scripts inside the game's folder (and inside mods). To show and dress a character exactly like the game does, the app has to read those files. To import a character's look, it reads that save's <code>players.db</code>.</p>
            <h4>What it does with them</h4>
            <p>It only <b>reads</b> them, into memory, to build the thumbnails and render the 3D character. Every step - reading files, converting models, drawing the character, exporting images - happens on your own computer.</p>
            <h4>Why it can't harm your files or your game</h4>
            <p><b>Read-only.</b> The app only ever reads your game files to display them. It never creates, writes, moves, renames or deletes anything, so it cannot change or break your game or your saves.</p>
            <p><b>Only what you point it at.</b> It reads only the folders you choose - your game install, your mods, or a save. As a desktop app it uses your operating system's own file access rather than the browser's sandbox, so it can open your game anywhere (including under <code>C:\Program Files</code>) and it remembers your folder so you don't pick it again each time.</p>
            {cloudConfigured ? (
              <p><b>Your game files never leave your machine.</b> Everything runs locally on your PC. Your game files, saves and mods are only ever read and are never uploaded - the only thing that can leave your machine is a render you explicitly choose to share online (which needs you to sign in), and only that render.</p>
            ) : (
              <p><b>Nothing is uploaded.</b> Everything runs locally on your PC; no game file, save or mod is ever sent anywhere.</p>
            )}
            <p><b>You stay in control.</b> Close the app and it stops reading your files. The only things kept are small local caches (thumbnails and converted meshes) on your PC, which you can wipe anytime with the <b>Clear</b> button. They are never sent anywhere.</p>
          </>
        ) : (
          <>
            <h4>Why it needs your files</h4>
            <p>Project Zomboid stores its characters as 3D models, textures and scripts inside the game's folder (and inside workshop mods). To show and dress a character exactly like the game does, the tool has to read those files. To import a character's look, it reads that save's <code>players.db</code>.</p>
            <h4>What it does with them</h4>
            <p>It only <b>reads</b> them, into your browser's memory, to build the thumbnails and render the 3D character. Every step (reading files, converting models, drawing the character, exporting images) happens on your own computer.</p>
            <h4>Why it can't harm your files or your game</h4>
            <p><b>Read-only.</b> The browser only ever grants this page permission to <i>read</i>. It cannot create, write, move, rename or delete anything, and there is no code here that modifies files, so it cannot change or break your game or your saves.</p>
            <p><b>Only the folder you choose.</b> The File System Access API is sandboxed by the browser: the page can see only the exact folder you pick, nothing else on your PC, and only for this tab. The permission isn't remembered, so you grant it again each session.</p>
            {cloudConfigured ? (
              <p><b>Your game files never leave your machine.</b> This is a static page with no server of its own. A strict Content-Security-Policy tells your browser to block every network request except to this app and, only if you choose to sign in, its optional sign-in and sharing service. Your game files, saves and mods are read-only and are never uploaded - the only thing that can ever leave your machine is a render you explicitly click to share, and only that render.</p>
            ) : (
              <p><b>Nothing is uploaded, and the browser enforces it.</b> There is no server behind this; it's a static page. A strict Content-Security-Policy instructs your browser to block <i>any</i> network request except loading the page's own code, so no game file, save or mod can leave your machine even if there were a bug.</p>
            )}
            <p><b>You stay in control.</b> Close the tab and all access ends. The only things kept are small local caches (thumbnails and converted meshes) in your browser's own storage, which you can wipe anytime with the <b>Clear</b> button. They are never sent anywhere.</p>
          </>
        )}
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
