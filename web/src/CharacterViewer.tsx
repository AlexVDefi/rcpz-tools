import { useEffect, useMemo, useRef, useState } from 'react';
import { listClips, listClothing, listHeldItems, listHair, clothingGroup, CLOTHING_GROUP_ORDER } from '@shared/character-core.js';
import { CharacterEngine, type Ctx } from './render/character-engine';
import { ThumbnailProvider } from './render/thumbnail-provider';
import { AssetGrid, type GridItem } from './AssetGrid';
import { Thumb } from './Thumb';

type Tab = 'animate' | 'clothing' | 'held' | 'hair';
interface Clip { id: string; name: string; actor: string; format: string; isMod: boolean; rel: string }

const firstLetter = (s: string) => (/[a-z]/i.test(s[0]) ? s[0].toUpperCase() : '#');

export function CharacterViewer({ ctx, index }: { ctx: Ctx; index: unknown }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<CharacterEngine | null>(null);
  const startedRef = useRef(false);
  const [gender, setGender] = useState<'male' | 'female'>('male');
  const [status, setStatus] = useState('loading body…');
  const [nowPlaying, setNowPlaying] = useState('');
  const [playing, setPlaying] = useState(true);
  const [tab, setTab] = useState<Tab>('animate');
  const [clipFilter, setClipFilter] = useState('');
  const [equipTick, setEquipTick] = useState(0); // bump to re-highlight equipped cards
  const [busy, setBusy] = useState('');

  const clips: Clip[] = useMemo(() => listClips(index), [index]);
  const clothing = useMemo(() => (listClothing(index) as Array<{ name: string; kind: string; location: string; isMod: boolean }>)
    .map((c) => ({ ...c, key: c.name, label: c.name, facet: clothingGroup(c) })), [index]);
  const held = useMemo(() => (listHeldItems(index) as Array<{ name: string }>)
    .map((h) => ({ ...h, key: h.name, label: h.name, facet: firstLetter(h.name), isMod: false })), [index]);
  const hairData = useMemo(() => listHair(index) as { hair: { male: { name: string }[]; female: { name: string }[] }; beards: { name: string }[] }, [index]);

  // one shared thumbnail renderer (its own GL context), IDB-cached, for the grids
  const thumbs = useMemo(() => new ThumbnailProvider(ctx), [ctx]);
  useEffect(() => () => thumbs.dispose(), [thumbs]);

  const shownClips = useMemo(() => {
    const f = clipFilter.trim().toLowerCase();
    return (f ? clips.filter((c) => c.name.toLowerCase().includes(f)) : clips).slice(0, 500);
  }, [clips, clipFilter]);

  // create engine once
  useEffect(() => {
    const eng = new CharacterEngine(canvasRef.current!, ctx);
    eng.onClipName = setNowPlaying;
    engineRef.current = eng;
    const onResize = () => eng.fit();
    window.addEventListener('resize', onResize);
    return () => { window.removeEventListener('resize', onResize); eng.dispose(); engineRef.current = null; };
  }, [ctx]);

  // load / swap body on gender change
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const eng = engineRef.current; if (!eng) return;
      setStatus('loading body…');
      try {
        await eng.loadBody(gender);
        if (cancelled) return;
        setStatus(''); setEquipTick((t) => t + 1);
        // Play a default idle once, like the desktop app: the character stands naturally
        // AND every added rig (hair/beard/clothing) seats against a common clip pose
        // instead of the unaligned raw bind pose.
        if (!startedRef.current) {
          startedRef.current = true;
          const idle = clips.find((c) => c.name === 'Bob_Idle')
            || clips.find((c) => /^bob_idle\b/i.test(c.name))
            || clips.find((c) => c.actor.toLowerCase() === 'bob' && /idle/i.test(c.name));
          if (idle) { try { await eng.playClip(idle); setPlaying(true); } catch { /* non-fatal */ } }
        }
      } catch (e) { if (!cancelled) setStatus('body error: ' + (e instanceof Error ? e.message : String(e))); }
    })();
    return () => { cancelled = true; };
  }, [gender, clips]);

  async function guard(label: string, fn: () => Promise<unknown>) {
    setBusy(label);
    try { await fn(); } catch (e) { setNowPlaying('error: ' + (e instanceof Error ? e.message : String(e))); }
    finally { setBusy(''); setEquipTick((t) => t + 1); }
  }

  const playClip = (c: Clip) => guard('loading ' + c.name, async () => { await engineRef.current!.playClip(c); setPlaying(true); });
  const toggleCloth = (it: { name: string }) => guard('equipping ' + it.name, () => engineRef.current!.toggleClothing(it));
  const toggleHeld = (it: { name: string }) => guard('equipping ' + it.name, () => engineRef.current!.toggleHeld(it));
  const togglePlay = () => { const e = engineRef.current; if (e) setPlaying(e.togglePlay()); };

  const tabs: [Tab, string][] = [['animate', 'Animate'], ['clothing', 'Clothing'], ['held', 'Held'], ['hair', 'Hair']];

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 360px', gap: 12, height: 'calc(100vh - 150px)', minHeight: 440 }}>
      <div style={{ position: 'relative', background: '#14141a', border: '1px solid var(--line)', borderRadius: 8, overflow: 'hidden' }}>
        <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
        <div style={{ position: 'absolute', left: 12, top: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
          <div style={{ display: 'flex', border: '1px solid var(--line)', borderRadius: 6, overflow: 'hidden' }}>
            {(['male', 'female'] as const).map((g) => (
              <button key={g} className="secondary" onClick={() => setGender(g)}
                style={{ borderRadius: 0, background: gender === g ? 'var(--accent)' : 'var(--panel)', color: gender === g ? '#fff' : 'var(--text)' }}>{g}</button>
            ))}
          </div>
          {(status || busy) && <span style={{ color: 'var(--muted)', background: '#00000099', padding: '4px 8px', borderRadius: 6 }}>{status || busy}</span>}
        </div>
        <div style={{ position: 'absolute', left: 12, bottom: 12, right: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="secondary" onClick={togglePlay}>{playing ? '❚❚' : '▶'}</button>
          <span style={{ color: 'var(--muted)', background: '#00000099', padding: '4px 8px', borderRadius: 6, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 }}>
            {nowPlaying || 'pick a clip →'}
          </span>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 8 }}>
        <div style={{ display: 'flex', borderBottom: '1px solid var(--line)' }}>
          {tabs.map(([t, label]) => (
            <button key={t} onClick={() => setTab(t)} className="secondary"
              style={{ flex: 1, borderRadius: 0, background: tab === t ? 'var(--accent)' : 'transparent', color: tab === t ? '#fff' : 'var(--text)' }}>{label}</button>
          ))}
        </div>

        <div style={{ flex: 1, minHeight: 0 }}>
          {tab === 'animate' && (
            <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
              <div style={{ padding: 8, borderBottom: '1px solid var(--line)' }}>
                <input value={clipFilter} onChange={(e) => setClipFilter(e.target.value)} placeholder={`Search ${clips.length} clips…`}
                  style={{ width: '100%', background: '#14141a', color: 'var(--text)', border: '1px solid var(--line)', borderRadius: 6, padding: '7px 9px' }} />
              </div>
              <div style={{ overflow: 'auto', flex: 1 }}>
                {shownClips.map((c) => (
                  <div key={c.id} onClick={() => playClip(c)}
                    style={{ padding: '4px 10px', cursor: 'pointer', fontFamily: 'monospace', fontSize: 12, display: 'flex', gap: 8 }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = '#ffffff10')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}>
                    <span style={{ color: c.isMod ? '#8ec77f' : 'var(--muted)', width: 44 }}>{c.actor}</span>
                    <span>{c.name}</span>
                  </div>
                ))}
                {clips.length > shownClips.length && <div style={{ padding: 10, color: 'var(--muted)' }}>+{clips.length - shownClips.length} more — refine search</div>}
              </div>
            </div>
          )}

          {tab === 'clothing' && (
            <AssetGrid<typeof clothing[number] & GridItem>
              items={clothing as (typeof clothing[number] & GridItem)[]}
              facetLabel="groups"
              facetOrder={CLOTHING_GROUP_ORDER as string[]}
              active={(it) => { void equipTick; return !!engineRef.current?.isEquipped(it.name); }}
              onPick={(it) => toggleCloth(it)}
              renderThumb={(it) => <Thumb depKey={`c:${it.name}:${gender}`} getUrl={() => thumbs.clothing(it, gender)} />} />
          )}

          {tab === 'held' && (
            <AssetGrid<typeof held[number] & GridItem>
              items={held as (typeof held[number] & GridItem)[]}
              facetLabel="letters"
              active={(it) => { void equipTick; return !!engineRef.current?.isHeld(it.name); }}
              onPick={(it) => toggleHeld(it)}
              renderThumb={(it) => <Thumb depKey={`h:${it.name}`} getUrl={() => thumbs.held(it)} />} />
          )}

          {tab === 'hair' && <HairTab hairData={hairData} gender={gender} engineRef={engineRef} />}
        </div>
      </div>
    </div>
  );
}

function HairTab({ hairData, gender, engineRef }: {
  hairData: { hair: { male: { name: string }[]; female: { name: string }[] }; beards: { name: string }[] };
  gender: 'male' | 'female';
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

  const row = { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 } as const;
  const sel = { flex: 1, background: '#14141a', color: 'var(--text)', border: '1px solid var(--line)', borderRadius: 6, padding: '7px 9px' } as const;
  return (
    <div style={{ padding: 12 }}>
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
