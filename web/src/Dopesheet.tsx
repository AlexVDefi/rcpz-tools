import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { CharacterEngine } from './render/character-engine';

export const keyId = (b: string, t: number) => b + '@' + t; // dopesheet keyframe selection id
export const parseKeySel = (s: Set<string>) => [...s].map((id) => { const i = id.lastIndexOf('@'); return { bone: id.slice(0, i), tick: +id.slice(i + 1) }; });

// --- toolbar building blocks -----------------------------------------------------------------
// Press-and-hold to keep stepping: fires once, then repeats after a short delay until release.
function RepeatButton({ onStep, title, className, children }: { onStep: () => void; title: string; className?: string; children: ReactNode }) {
  const ids = useRef<{ to: number; iv: number }>({ to: 0, iv: 0 });
  const stop = () => { clearTimeout(ids.current.to); clearInterval(ids.current.iv); ids.current = { to: 0, iv: 0 }; };
  const start = (e: React.PointerEvent) => { if (e.button !== 0) return; e.preventDefault(); stop(); onStep(); ids.current.to = window.setTimeout(() => { ids.current.iv = window.setInterval(onStep, 55); }, 320); };
  useEffect(() => stop, []);
  return <button type="button" className={className} title={title} aria-label={title} onPointerDown={start} onPointerUp={stop} onPointerLeave={stop} onPointerCancel={stop}>{children}</button>;
}
// A value that reads as formatted text (e.g. "12 fr") but becomes a free-type field on click.
function NumField({ value, display, onCommit, integer, min, max, title, width = 54 }: { value: number; display: string; onCommit: (n: number) => void; integer?: boolean; min?: number; max?: number; title?: string; width?: number }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const commit = () => { setEditing(false); const n = integer ? parseInt(draft, 10) : parseFloat(draft); if (!Number.isNaN(n)) { let v = n; if (min != null) v = Math.max(min, v); if (max != null) v = Math.min(max, v); onCommit(v); } };
  if (editing) return (
    <input autoFocus className="ds-val ds-val-edit" style={{ width }} value={draft} inputMode={integer ? 'numeric' : 'decimal'}
      onChange={(e) => setDraft(e.target.value.replace(integer ? /[^0-9]/g : /[^0-9.]/g, ''))}
      onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') commit(); else if (e.key === 'Escape') setEditing(false); }} />
  );
  return <button type="button" className="ds-val" style={{ width }} title={title ?? 'Click to type a value'} onClick={() => { setDraft(integer ? String(Math.round(value)) : String(value)); setEditing(true); }}>{display}</button>;
}
// compact functional icons (currentColor, ~15px)
const ico = (children: ReactNode, opts?: { fill?: string; sw?: number }) => (
  <svg width={15} height={15} viewBox="0 0 16 16" fill={opts?.fill ?? 'none'} stroke="currentColor" strokeWidth={opts?.sw ?? 1.5} strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>{children}</svg>
);
const IcoMinus = () => ico(<line x1="3.5" y1="8" x2="12.5" y2="8" />, { sw: 1.7 });
const IcoPlus = () => ico(<><line x1="8" y1="3.5" x2="8" y2="12.5" /><line x1="3.5" y1="8" x2="12.5" y2="8" /></>, { sw: 1.7 });
const IcoDiamond = () => (<svg width={13} height={13} viewBox="0 0 16 16" style={{ display: 'block' }}><rect x="4.2" y="4.2" width="7.6" height="7.6" rx="1" transform="rotate(45 8 8)" fill="currentColor" /></svg>);
const IcoRecord = ({ on }: { on: boolean }) => (<svg width={15} height={15} viewBox="0 0 16 16" style={{ display: 'block' }}><circle cx="8" cy="8" r="5" fill={on ? '#ff3b3b' : 'none'} stroke={on ? '#ff3b3b' : 'currentColor'} strokeWidth="1.5" /></svg>);
const IcoEnds = () => ico(<><line x1="3" y1="3.5" x2="3" y2="12.5" /><line x1="13" y1="3.5" x2="13" y2="12.5" /><rect x="6.4" y="6.4" width="3.2" height="3.2" transform="rotate(45 8 8)" fill="currentColor" stroke="none" /></>);
const IcoFit = () => ico(<><path d="M3 6 V3 H6" /><path d="M13 6 V3 H10" /><path d="M3 10 V13 H6" /><path d="M13 10 V13 H10" /></>);
const IcoFilter = () => ico(<path d="M2.5 3.5 H13.5 L9.3 8.3 V12.5 L6.7 11 V8.3 Z" />);
const IcoReset = () => ico(<><path d="M12.8 8 a4.8 4.8 0 1 1 -1.4 -3.4" /><path d="M13.6 2.6 V4.8 H11.4" /></>);
const IcoCopy = () => ico(<><rect x="5.5" y="5.5" width="7" height="7" rx="1.3" /><path d="M3.5 10.5 V4 A1.3 1.3 0 0 1 4.8 2.7 H10.5" /></>);
const IcoPaste = () => ico(<><rect x="3.5" y="3" width="9" height="10.5" rx="1.3" /><path d="M6 3 V2.2 H10 V3" /><line x1="6" y1="7.2" x2="10" y2="7.2" /><line x1="6" y1="9.8" x2="10" y2="9.8" /></>);
const IcoTrash = () => ico(<><path d="M3.5 4.5 H12.5" /><path d="M5.5 4.5 V3.2 H10.5 V4.5" /><path d="M4.7 4.5 L5.2 12.4 A1 1 0 0 0 6.2 13.3 H9.8 A1 1 0 0 0 10.8 12.4 L11.3 4.5" /></>);
const IcoClose = () => ico(<><line x1="4" y1="4" x2="12" y2="12" /><line x1="12" y1="4" x2="4" y2="12" /></>);
const IcoPlay = () => (<svg width={12} height={12} viewBox="0 0 16 16" style={{ display: 'block' }}><path d="M4.5 3 L12.5 8 L4.5 13 Z" fill="currentColor" /></svg>);
const IcoPause = () => (<svg width={12} height={12} viewBox="0 0 16 16" style={{ display: 'block' }}><rect x="4" y="3.3" width="3" height="9.4" rx="1" fill="currentColor" /><rect x="9" y="3.3" width="3" height="9.4" rx="1" fill="currentColor" /></svg>);
const IcoReplay = () => ico(<><path d="M12.8 8 a4.8 4.8 0 1 1 -1.4 -3.4" /><path d="M13.6 2.6 V4.8 H11.4" /></>);
const IcoLoop = () => ico(<><path d="M3.5 7.2 V6.4 A2.7 2.7 0 0 1 6.2 3.7 H10.6" /><path d="M9 2.2 L11 3.7 L9 5.2" /><path d="M12.5 8.8 V9.6 A2.7 2.7 0 0 1 9.8 12.3 H5.4" /><path d="M7 10.8 L5 12.3 L7 13.8" /></>);

type DopesheetProps = {
  engine: CharacterEngine;
  boneTick: number;                                             // parent bumps this to force a re-read of engine values
  bump: () => void;                                             // request a parent re-render after mutating the engine
  keySel: Set<string>;
  setKeySel: React.Dispatch<React.SetStateAction<Set<string>>>;
  scrubbingRef: React.MutableRefObject<boolean>;                // shared with the transport scrub + onFrame
  playheadRef: React.RefObject<HTMLDivElement>;                 // positioned by the parent's onFrame without a re-render
  trackGeomRef: React.MutableRefObject<{ pad: number; usable: number }>; // tick->px mapping, read by onFrame
  onToast: (msg: string) => void;
  playing: boolean; onTogglePlay: () => void; onReplay: () => void; // transport (folded into the toolbar so it's all one row)
  loop: boolean; onToggleLoop: () => void;
  speed: number; onSpeed: (s: number) => void;
};

export function Dopesheet({ engine, boneTick, bump, keySel, setKeySel, scrubbingRef, playheadRef, trackGeomRef, onToast, playing, onTogglePlay, onReplay, loop, onToggleLoop, speed, onSpeed }: DopesheetProps) {
  const [zoom, setZoom] = useState(1);            // horizontal zoom (1 = fit)
  const [selOnly, setSelOnly] = useState(false);  // only show tracks for the selected bone(s)
  const [autoKey, setAutoKey] = useState(() => engine.autoKeyOn());       // posing writes a key at the current time
  const [autoEnds, setAutoEnds] = useState(() => engine.autoEndpointsOn()); // first edit of a bone keys the first + last frame
  const [keyDrag, setKeyDrag] = useState<{ bone: string; from: number; grabFrac: number; curFrac: number } | null>(null); // a keyframe (group) being dragged
  const [keyBox, setKeyBox] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null); // rubber-band box (ruler-local px)
  const [viewW, setViewW] = useState(0);            // scroll-viewport width, so the timeline can fill the panel and grey the area past the animation end
  const scrollRef = useRef<HTMLDivElement>(null);   // horizontal scroll viewport
  const rulerRef = useRef<HTMLDivElement>(null);    // track area, for mapping cursor x to a tick
  const thumbRef = useRef<HTMLDivElement>(null);    // custom slim scrollbar thumb
  const thumbDragRef = useRef<{ startX: number; startLeft: number } | null>(null);
  const panRef = useRef<{ startX: number; startLeft: number } | null>(null); // middle-mouse drag pan
  const boxRef = useRef<{ x0: number; y0: number } | null>(null);
  const endDragRef = useRef(false);                  // dragging the clip-end marker on the timeline
  const zoomRef = useRef(1);                          // live zoom for the native wheel handler (avoids a stale closure)
  const baseWidthRef = useRef(1);                     // timeline width in px at zoom 1 (px-per-frame * frames)
  const pendingScrollRef = useRef<number | null>(null); // scrollLeft to apply after a wheel-zoom re-render (cursor-anchored)
  zoomRef.current = zoom;
  const updateThumb = useCallback(() => { // size + place the custom thumb from the scroll state; hidden when nothing overflows
    const sc = scrollRef.current, th = thumbRef.current; if (!sc || !th) return;
    const cw = sc.clientWidth, sw = sc.scrollWidth;
    if (sw <= cw + 1) { th.style.display = 'none'; return; } // nothing to scroll
    th.style.display = 'block';
    th.style.width = `${(cw / sw) * 100}%`;
    th.style.left = `${(sc.scrollLeft / sw) * 100}%`;
  }, []);
  useLayoutEffect(() => { if (pendingScrollRef.current != null && scrollRef.current) { scrollRef.current.scrollLeft = pendingScrollRef.current; pendingScrollRef.current = null; } updateThumb(); }, [zoom, updateThumb]); // apply a cursor-anchored zoom, then resize the thumb
  useLayoutEffect(() => { const cw = scrollRef.current?.clientWidth; if (cw && baseWidthRef.current > 0) { pendingScrollRef.current = 0; setZoom(Math.max(0.02, (cw - 2) / baseWidthRef.current)); } }, []); // fit all frames on mount (-2px so it never overflows)
  useEffect(() => { // wheel: zoom in/out, anchored to the cursor (Blender-style; native listener so preventDefault works)
    const el = scrollRef.current; if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const z = zoomRef.current, bw = baseWidthRef.current;
      const rect = el.getBoundingClientRect(), cursorX = e.clientX - rect.left, innerW = bw * z;
      const frac = innerW > 0 ? (el.scrollLeft + cursorX) / innerW : 0;
      const nz = Math.max(0.02, Math.min(40, +(z * (e.deltaY < 0 ? 1.25 : 1 / 1.25)).toFixed(3)));
      pendingScrollRef.current = frac * (bw * nz) - cursorX; // keep the frame under the cursor fixed
      setZoom(nz);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);
  useEffect(() => { const el = scrollRef.current; if (!el) return; const ro = new ResizeObserver(() => setViewW(el.clientWidth)); ro.observe(el); setViewW(el.clientWidth); return () => ro.disconnect(); }, []); // track the viewport width so the ruler can fill it

  void boneTick; const eng = engine;
  const tl = eng.keyframeTimeline(); const [lo, hi] = tl.range; const span = Math.max(1, hi - lo);
  const frames = tl.frames;                            // real (rounded) frame ticks within the range - where keyframes actually sit
  const frameStep = tl.frameCount > 1 ? Math.max(1e-3, (tl.scaledEnd - lo) / (tl.frameCount - 1)) : Math.max(1, span); // tick interval between frames (constant while extending; changes with retime)
  const rangeFrames = frameStep > 0 ? (hi - lo) / frameStep : Math.max(1, tl.frameCount - 1); // frame intervals across the visible range (grows on extend, shrinks on trim)
  const baseWidth = Math.max(140, (rangeFrames + 1) * 14); baseWidthRef.current = baseWidth; // px timeline width at zoom 1, proportional to the range so extend/trim resize it
  const innerW = baseWidth * zoom;
  const PAD = 6, usable = Math.max(1, innerW - 2 * PAD); trackGeomRef.current = { pad: PAD, usable }; // inset so edge diamonds/labels stay inside the track
  const xOfTick = (t: number) => PAD + ((t - lo) / span) * usable; // the ONE tick->x mapping: grid lines, keyframes, playhead and the grey all use it, so keys always sit on a line
  const clampZoom = (z: number) => Math.max(0.02, Math.min(40, +z.toFixed(3)));
  const doFit = () => { const cw = scrollRef.current?.clientWidth; if (cw) { pendingScrollRef.current = 0; setZoom(Math.max(0.02, (cw - 2) / baseWidth)); requestAnimationFrame(updateThumb); } }; // -2px so the timeline never overflows; refresh the thumb even if zoom is unchanged
  const kid = keyId, parseSel = parseKeySel;
  const selDriven = selOnly ? new Set(eng.affectedForSelection()) : null; // a handle drives a whole chain, so filter by driven bones
  const tracks = selDriven ? tl.tracks.filter((t) => selDriven.has(t.bone)) : tl.tracks;
  const fracAt = (clientX: number) => { const r = rulerRef.current?.getBoundingClientRect(); return r && r.width > 0 ? Math.max(0, Math.min(1, (clientX - r.left - PAD) / usable)) : 0; };
  const snap = (tick: number) => frames.length ? frames.reduce((best, f) => Math.abs(f - tick) < Math.abs(best - tick) ? f : best, frames[0]) : Math.round(tick);
  const tickAt = (clientX: number) => { const t = lo + fracAt(clientX) * span, g = frameStep > 0 ? lo + Math.round((t - lo) / frameStep) * frameStep : Math.round(t); return Math.max(lo, Math.min(hi, g)); }; // scrub snaps to the frame grid across the WHOLE range (incl. the extended hold past the last real frame), not just to real keyframe frames
  const mono = 'ui-monospace,SFMono-Regular,Menlo,monospace';
  const pxPerFrame = span > 0 ? (frameStep / span) * usable : usable;                 // px between frame lines
  const gridStep = Math.max(1, Math.ceil(6 / Math.max(0.01, pxPerFrame)));            // keep >= ~6px between drawn frame lines
  const labelStep = gridStep * Math.max(1, Math.round(48 / (pxPerFrame * gridStep))); // a frame number roughly every 48px
  const HEAD = 19, LANE = 15, SUM = 15;             // ruler-header (scrub strip), per-bone lane, summary lane heights (px)
  const laneTop = (ti: number) => HEAD + SUM + ti * LANE; // y of bone lane `ti` inside the ruler
  const summaryTicks = [...new Set(tracks.flatMap((t) => t.keys))].sort((a, b) => a - b); // every frame that has any keyframe
  const frameIds = (tick: number) => tracks.filter((t) => t.keys.includes(tick)).map((t) => kid(t.bone, tick)); // all bone keys on a frame
  const SUMMARY = 'sum'; // sentinel keyDrag.bone for a whole-frame (summary) drag
  const fullW = Math.max(innerW, viewW);            // fill the viewport when the clip is shorter than the panel
  const lastX = xOfTick(hi);                        // the clip end (= innerW - PAD); everything to the right of this is greyed
  // Frame lines: draw them at the REAL frame ticks (so a keyframe is always on one), then extrapolate the
  // same interval to fill the viewport and grey the region past the clip end.
  const gridLines: { key: number; x: number; label: number; major: boolean; beyond: boolean }[] = [];
  for (let i = 0; i < frames.length; i++) { if (i % gridStep) continue; gridLines.push({ key: i, x: xOfTick(frames[i]), label: i, major: i % labelStep === 0, beyond: false }); }
  { const lastReal = frames.length ? frames[frames.length - 1] : lo, baseIdx = frames.length ? frames.length - 1 : 0;
    for (let k = 1; k < 100000; k++) { const idx = baseIdx + k, tick = lastReal + k * frameStep, x = xOfTick(tick); if (x >= fullW) break; if (idx % gridStep) continue; gridLines.push({ key: idx, x, label: idx, major: idx % labelStep === 0, beyond: tick > hi + frameStep * 0.5 }); } }
  for (const t of summaryTicks) if (t >= lo && t <= hi) gridLines.push({ key: 1e6 + t, x: xOfTick(t), label: 0, major: false, beyond: false }); // a guaranteed line directly under every keyframe
  const endFrames = tl.clipEnd != null ? Math.max(2, Math.round((tl.clipEnd - lo) / frameStep) + 1) : tl.frameCount; // the clip end as a frame count
  const setEndFrames = (n: number) => { eng.setClipEnd(Math.round(lo + (Math.max(2, n) - 1) * frameStep)); bump(); };
  const endTickFromX = (clientX: number) => { const r = rulerRef.current?.getBoundingClientRect(); if (!r) return hi; const t = lo + ((clientX - r.left - PAD) / usable) * span; const g = frameStep > 0 ? lo + Math.round((t - lo) / frameStep) * frameStep : Math.round(t); return Math.round(Math.max(lo + frameStep * 1.5, g)); }; // cursor -> end tick (not clamped, so dragging right extends)
  return (
    <div style={{ padding: '8px 10px 9px', borderBottom: '1px solid rgba(255,255,255,.07)', userSelect: 'none', WebkitUserSelect: 'none' }}>
      <style>{`
        .ds-lbl{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.15em;color:var(--muted)}
        .ds-chip{font-size:9.5px;font-weight:600;color:var(--muted);font-variant-numeric:tabular-nums;font-family:${mono};padding:2px 7px;border:1px solid rgba(255,255,255,.1);border-radius:20px}
        .ds-ico{box-sizing:border-box;width:26px;height:26px;padding:0;margin:0;line-height:0;font-size:0;display:inline-flex;align-items:center;justify-content:center;border-radius:7px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.02);color:var(--text);cursor:pointer;transition:background .12s,border-color .12s,transform .05s,color .12s}
        .ds-ico:hover{background:rgba(255,255,255,.08);border-color:rgba(255,255,255,.24)}
        .ds-ico:active{transform:translateY(1px)}
        .ds-ico[data-on]{background:var(--accent);border-color:transparent;color:#fff}
        .ds-ico[data-on]:hover{filter:brightness(1.12)}
        .ds-ico[data-rec]{background:rgba(255,59,59,.14);border-color:rgba(255,59,59,.5)}
        .ds-ico:disabled{opacity:.38;cursor:default;transform:none}
        .ds-seg{box-sizing:border-box;display:inline-flex;align-items:stretch;height:26px;border:1px solid rgba(255,255,255,.1);border-radius:7px;overflow:hidden;background:rgba(255,255,255,.02)}
        .ds-step{box-sizing:border-box;border:0;padding:0;margin:0;line-height:0;font-size:0;background:transparent;color:var(--text);cursor:pointer;width:23px;display:inline-flex;align-items:center;justify-content:center;transition:background .12s,transform .05s}
        .ds-step:hover{background:rgba(255,255,255,.1)}
        .ds-step:active{transform:translateY(1px)}
        .ds-val{box-sizing:border-box;padding:0 2px;margin:0;border:0;border-left:1px solid rgba(255,255,255,.09);border-right:1px solid rgba(255,255,255,.09);background:transparent;color:var(--text);font-size:11px;font-variant-numeric:tabular-nums;font-family:${mono};display:inline-flex;align-items:center;justify-content:center;cursor:text;transition:background .12s}
        .ds-val:hover{background:rgba(255,255,255,.07)}
        .ds-val-edit{display:inline-block;text-align:center;outline:none;background:rgba(91,140,255,.18);color:#fff}
        .ds-key{transition:transform .08s ease}
        .ds-key:hover{transform:rotate(45deg) scale(1.3)!important;z-index:2}
        .ds-scroll::-webkit-scrollbar{display:none}
      `}</style>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <button type="button" className="ds-ico" title={playing ? 'Pause' : 'Play'} onClick={onTogglePlay}>{playing ? <IcoPause /> : <IcoPlay />}</button>
        <button type="button" className="ds-ico" title="Play from the start" onClick={onReplay}><IcoReplay /></button>
        <span style={{ width: 1, height: 18, background: 'rgba(255,255,255,.1)', margin: '0 1px' }} />
        <span className="ds-lbl">Dopesheet</span>
        <span className="ds-chip">{frames.length} fr</span>
        <span className="ds-lbl" style={{ marginLeft: 4 }}>len</span>
        <span className="ds-seg" title="Retime the whole clip - stretch or squash its length (rescales every keyframe). Hold to repeat; click the value to type.">
          <RepeatButton className="ds-step" title="Shorter" onStep={() => { eng.setLengthScale(eng.lengthScaleOf() / 1.06); bump(); }}><IcoMinus /></RepeatButton>
          <NumField value={tl.lengthScale} display={`${tl.lengthScale.toFixed(2)}x`} width={48} title="Length multiplier - click to type" onCommit={(n) => { eng.setLengthScale(n); bump(); }} />
          <RepeatButton className="ds-step" title="Longer" onStep={() => { eng.setLengthScale(eng.lengthScaleOf() * 1.06); bump(); }}><IcoPlus /></RepeatButton>
        </span>
        <span className="ds-lbl">end</span>
        <span className="ds-seg" title="Trim or extend the clip end (cut the tail, or hold the last pose). Hold to repeat; click the value to type; or drag the end marker on the timeline.">
          <RepeatButton className="ds-step" title="Trim a frame" onStep={() => { eng.nudgeClipEnd(-1); bump(); }}><IcoMinus /></RepeatButton>
          <NumField value={endFrames} display={`${endFrames} fr`} integer min={2} width={48} title="End frame count - click to type a whole number" onCommit={setEndFrames} />
          <RepeatButton className="ds-step" title="Extend a frame" onStep={() => { eng.nudgeClipEnd(1); bump(); }}><IcoPlus /></RepeatButton>
        </span>
        {tl.clipEnd != null && <button type="button" className="ds-ico" title="Reset the end to full length" onClick={() => { eng.setClipEnd(null); bump(); }}><IcoReset /></button>}
        <span style={{ flex: 1 }} />
        <button type="button" className="ds-ico" data-rec={autoKey || undefined} title={`Auto-key: ${autoKey ? 'ON' : 'off'} - posing a bone writes a keyframe at the playhead`} onClick={() => { const n = !autoKey; setAutoKey(n); eng.setAutoKey(n); }}><IcoRecord on={autoKey} /></button>
        <button type="button" className="ds-ico" data-on={autoEnds || undefined} title={`Auto-ends: ${autoEnds ? 'ON' : 'off'} - a bone's first edit also keys the first + last frame`} onClick={() => { const n = !autoEnds; setAutoEnds(n); eng.setAutoEndpoints(n); }}><IcoEnds /></button>
        <button type="button" className="ds-ico" style={{ color: '#3ec96b' }} title="Add a keyframe for the current pose at the playhead" onClick={() => { eng.addKeyAtCurrent(); bump(); }}><IcoDiamond /></button>
        <span style={{ width: 1, height: 18, background: 'rgba(255,255,255,.1)', margin: '0 1px' }} />
        <button type="button" className="ds-ico" data-on={selOnly || undefined} title="Show only the selected bone's tracks" onClick={() => setSelOnly((v) => !v)}><IcoFilter /></button>
        <button type="button" className="ds-ico" title="Fit all frames in view" onClick={doFit}><IcoFit /></button>
        <span className="ds-seg" title="Zoom (or scroll over the timeline)">
          <RepeatButton className="ds-step" title="Zoom out" onStep={() => setZoom((z) => clampZoom(z / 1.15))}><IcoMinus /></RepeatButton>
          <span className="ds-val" style={{ width: 42, cursor: 'default' }}>{zoom < 1 ? zoom.toFixed(2) : zoom.toFixed(1)}x</span>
          <RepeatButton className="ds-step" title="Zoom in" onStep={() => setZoom((z) => clampZoom(z * 1.15))}><IcoPlus /></RepeatButton>
        </span>
        <span style={{ width: 1, height: 18, background: 'rgba(255,255,255,.1)', margin: '0 1px' }} />
        <button type="button" className="ds-ico" data-on={loop || undefined} title={`Loop: ${loop ? 'on' : 'off'}`} onClick={onToggleLoop}><IcoLoop /></button>
        <select value={speed} onChange={(e) => onSpeed(Number(e.target.value))} title="Playback speed" style={{ height: 26, boxSizing: 'border-box', background: 'rgba(255,255,255,.02)', color: 'var(--text)', border: '1px solid rgba(255,255,255,.1)', borderRadius: 7, padding: '0 4px', fontSize: 11, fontFamily: mono, cursor: 'pointer' }}>
          {[0.25, 0.5, 1, 2].map((s) => <option key={s} value={s}>{s}x</option>)}
        </select>
      </div>
      {keySel.size > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
          <span className="ds-chip" style={{ borderColor: 'rgba(255,210,63,.45)', color: '#ffd23f' }}>{keySel.size} key{keySel.size === 1 ? '' : 's'} selected</span>
          <span style={{ flex: 1 }} />
          <button type="button" className="ds-ico" title="Copy the selected keyframes" onClick={() => { const n = eng.copyKeys(parseSel(keySel)); onToast(`copied ${n} keyframe${n === 1 ? '' : 's'}`); }}><IcoCopy /></button>
          <button type="button" className="ds-ico" disabled={!eng.keyClipboardSize()} title="Paste copied keyframes at the playhead" onClick={() => { const p = eng.pasteKeysAt(eng.currentTick()); setKeySel(new Set(p.map((m) => kid(m.bone, m.tick)))); bump(); }}><IcoPaste /></button>
          <button type="button" className="ds-ico" title="Delete the selected keyframes" onClick={() => { eng.deleteKeys(parseSel(keySel)); setKeySel(new Set()); bump(); }}><IcoTrash /></button>
          <button type="button" className="ds-ico" title="Clear selection" onClick={() => setKeySel(new Set())}><IcoClose /></button>
        </div>
      )}
      <div style={{ display: 'flex', gap: 6 }}>
        <div style={{ width: 66, flexShrink: 0 }}>
          <div style={{ height: HEAD }} />
          {summaryTicks.length > 0 && <div title="Summary - every frame that has any keyframe" style={{ height: SUM, fontSize: 10, fontWeight: 600, letterSpacing: '.03em', color: 'var(--muted)', lineHeight: `${SUM}px`, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>summary</div>}
          {tracks.map((t) => <div key={t.bone} title={t.bone} style={{ height: LANE, fontSize: 10.5, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', lineHeight: `${LANE}px` }}>{t.bone.replace(/^Bip01_?/, '')}</div>)}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div ref={scrollRef} className="ds-scroll" onScroll={updateThumb} style={{ overflowX: 'scroll', overflowY: 'hidden', scrollbarWidth: 'none' }}>
            <div ref={rulerRef} style={{ position: 'relative', width: `${fullW}px`, minHeight: tracks.length ? undefined : 56, overflow: 'hidden', cursor: 'crosshair', touchAction: 'none' }}
            onMouseDown={(e) => e.preventDefault()} // no text selection / focus, and kills middle-click autoscroll
            onPointerDown={(e) => {
              if (e.button === 1) { (e.currentTarget as Element).setPointerCapture(e.pointerId); panRef.current = { startX: e.clientX, startLeft: scrollRef.current?.scrollLeft ?? 0 }; return; } // middle-drag = pan
              if (e.button !== 0) return; (e.currentTarget as Element).setPointerCapture(e.pointerId);
              const r = rulerRef.current!.getBoundingClientRect(); const x = e.clientX - r.left, y = e.clientY - r.top;
              boxRef.current = { x0: x, y0: y }; setKeyBox({ x0: x, y0: y, x1: x, y1: y }); // plain left-drag in the lanes = rubber-band select (scrubbing lives on the header strip)
            }}
            onPointerMove={(e) => {
              if (boxRef.current) { const r = rulerRef.current!.getBoundingClientRect(); setKeyBox({ x0: boxRef.current.x0, y0: boxRef.current.y0, x1: e.clientX - r.left, y1: e.clientY - r.top }); return; }
              if (panRef.current) { if (!(e.buttons & 4)) { panRef.current = null; return; } if (scrollRef.current) scrollRef.current.scrollLeft = panRef.current.startLeft - (e.clientX - panRef.current.startX); return; }
            }}
            onPointerUp={(e) => {
              if (boxRef.current) {
                const r = rulerRef.current!.getBoundingClientRect(), x1 = e.clientX - r.left, y1 = e.clientY - r.top;
                const minX = Math.min(boxRef.current.x0, x1), maxX = Math.max(boxRef.current.x0, x1), minY = Math.min(boxRef.current.y0, y1), maxY = Math.max(boxRef.current.y0, y1);
                if (maxX - minX < 3 && maxY - minY < 3) { if (!e.shiftKey) setKeySel(new Set()); } // a click on empty space clears the selection
                else {
                  const picked = new Set<string>();
                  tracks.forEach((t, ti) => { const top = laneTop(ti), bot = top + LANE; if (bot < minY || top > maxY) return; for (const tick of t.keys) { const x = PAD + ((tick - lo) / span) * usable; if (x >= minX && x <= maxX) picked.add(kid(t.bone, tick)); } });
                  setKeySel((prev) => e.shiftKey ? new Set([...prev, ...picked]) : picked); // shift adds to the selection, otherwise replace
                }
                boxRef.current = null; setKeyBox(null);
              }
              panRef.current = null; try { (e.currentTarget as Element).releasePointerCapture(e.pointerId); } catch { /* not captured */ }
            }}
            onPointerCancel={() => { panRef.current = null; boxRef.current = null; setKeyBox(null); }}
            onLostPointerCapture={() => { panRef.current = null; boxRef.current = null; setKeyBox(null); }}>
            {gridLines.map((g) => (
              <div key={g.key} style={{ position: 'absolute', left: `${g.x}px`, top: g.major ? 0 : HEAD, bottom: 0, width: 1, marginLeft: -0.5, background: g.beyond ? 'rgba(255,255,255,.04)' : g.major ? 'rgba(255,255,255,.13)' : 'rgba(255,255,255,.05)', pointerEvents: 'none', zIndex: 0 }}>
                {g.major && <span style={{ position: 'absolute', top: 4, left: 3, fontSize: 9, color: g.beyond ? 'rgba(255,255,255,.22)' : 'var(--muted)', fontFamily: mono, fontVariantNumeric: 'tabular-nums', pointerEvents: 'none' }}>{g.label}</span>}
              </div>
            ))}
            {fullW > lastX + 1 && <div title="No animation past the clip end" style={{ position: 'absolute', left: `${lastX}px`, top: 0, width: `${fullW - lastX}px`, bottom: 0, background: 'rgba(0,0,0,.4)', pointerEvents: 'none', zIndex: 1 }} />}
            <div title="Drag to set the clip end (trim / extend)" style={{ position: 'absolute', left: `${lastX}px`, top: 0, bottom: 0, width: 11, marginLeft: -5.5, cursor: 'ew-resize', zIndex: 5, touchAction: 'none' }}
              onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); (e.currentTarget as Element).setPointerCapture(e.pointerId); endDragRef.current = true; }}
              onPointerMove={(e) => { if (!endDragRef.current) return; const t = endTickFromX(e.clientX); if (t !== tl.clipEnd) { eng.setClipEnd(t); bump(); } }}
              onPointerUp={(e) => { endDragRef.current = false; try { (e.currentTarget as Element).releasePointerCapture(e.pointerId); } catch { /* not captured */ } }}
              onPointerCancel={() => { endDragRef.current = false; }} onLostPointerCapture={() => { endDragRef.current = false; }}>
              <div style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: 2, marginLeft: -1, background: 'rgba(255,176,52,.85)', pointerEvents: 'none' }} />
              <div style={{ position: 'absolute', left: '50%', top: 3, width: 8, height: 8, marginLeft: -4, transform: 'rotate(45deg)', background: '#ffb034', border: '1px solid rgba(0,0,0,.5)', pointerEvents: 'none' }} />
            </div>
            <div ref={playheadRef} style={{ position: 'absolute', top: 0, bottom: 0, width: 2, marginLeft: -1, background: 'var(--accent)', pointerEvents: 'none', zIndex: 3 }}>
              <div style={{ position: 'absolute', top: 0, left: '50%', transform: 'translateX(-50%)', width: 0, height: 0, borderLeft: '4px solid transparent', borderRight: '4px solid transparent', borderTop: '5px solid var(--accent)' }} />
            </div>
            <div title="Drag here to scrub the playhead" style={{ height: HEAD, borderBottom: '1px solid rgba(255,255,255,.12)', background: 'rgba(255,255,255,.04)', cursor: 'ew-resize' }}
              onPointerDown={(e) => {
                if (e.button === 1) { e.stopPropagation(); (e.currentTarget as Element).setPointerCapture(e.pointerId); panRef.current = { startX: e.clientX, startLeft: scrollRef.current?.scrollLeft ?? 0 }; return; }
                if (e.button !== 0) return; e.stopPropagation(); (e.currentTarget as Element).setPointerCapture(e.pointerId); scrubbingRef.current = true; eng.seekTick(tickAt(e.clientX));
              }}
              onPointerMove={(e) => {
                if (panRef.current) { if (!(e.buttons & 4)) { panRef.current = null; return; } if (scrollRef.current) scrollRef.current.scrollLeft = panRef.current.startLeft - (e.clientX - panRef.current.startX); return; }
                if (scrubbingRef.current) { if (!(e.buttons & 1)) { scrubbingRef.current = false; return; } eng.seekTick(tickAt(e.clientX)); }
              }}
              onPointerUp={(e) => { scrubbingRef.current = false; panRef.current = null; try { (e.currentTarget as Element).releasePointerCapture(e.pointerId); } catch { /* not captured */ } }}
              onPointerCancel={() => { scrubbingRef.current = false; panRef.current = null; }} onLostPointerCapture={() => { scrubbingRef.current = false; panRef.current = null; }} />
            {(() => {
              const df = keyDrag ? (snap(keyDrag.from + (keyDrag.curFrac - keyDrag.grabFrac) * span) - keyDrag.from) / span : 0; // snap the live drag to frame lines (same snap the drop uses)
              const summaryDrag = !!keyDrag && keyDrag.bone === SUMMARY;
              return (<>
              {summaryTicks.length > 0 && (
                <div style={{ height: SUM, position: 'relative', background: 'rgba(255,255,255,.05)' }}>
                  {summaryTicks.map((tick) => {
                    const ids = frameIds(tick), allSel = ids.length > 0 && ids.every((id) => keySel.has(id)), anySel = ids.some((id) => keySel.has(id));
                    const primary = summaryDrag && keyDrag!.from === tick, moving = !!keyDrag && anySel;
                    const origFrac = (tick - lo) / span, shownFrac = moving ? Math.max(0, Math.min(1, origFrac + df)) : origFrac;
                    return (
                      <div key={tick} className="ds-key" title={`frame ${tick} - every key on this frame. click selects them all, shift-click adds, drag moves them`}
                        onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); (e.currentTarget as Element).setPointerCapture(e.pointerId); if (e.shiftKey) { setKeySel((prev) => { const n = new Set(prev); const all = ids.every((id) => n.has(id)); ids.forEach((id) => all ? n.delete(id) : n.add(id)); return n; }); return; } if (!(ids.length > 0 && ids.every((id) => keySel.has(id)))) setKeySel(new Set(ids)); const gf = fracAt(e.clientX); setKeyDrag({ bone: SUMMARY, from: tick, grabFrac: gf, curFrac: gf }); }} // keep an existing multi-frame selection when grabbing a frame that's already in it
                        onPointerMove={(e) => { if (primary) { if (!(e.buttons & 1)) { setKeyDrag(null); return; } setKeyDrag((kd) => kd ? { ...kd, curFrac: fracAt(e.clientX) } : null); } }}
                        onPointerUp={(e) => { e.stopPropagation(); if (!primary) return; const dt = snap(keyDrag!.from + (keyDrag!.curFrac - keyDrag!.grabFrac) * span) - keyDrag!.from; if (dt !== 0) { const moved = eng.moveKeys(parseSel(keySel), dt); setKeySel(new Set(moved.map((m) => kid(m.bone, m.tick)))); bump(); } setKeyDrag(null); }}
                        onPointerCancel={() => setKeyDrag(null)} onLostPointerCapture={() => { if (primary) setKeyDrag(null); }}
                        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); eng.deleteKeys(parseSel(new Set(ids))); setKeySel((prev) => { const n = new Set(prev); ids.forEach((id) => n.delete(id)); return n; }); bump(); }}
                        style={{ position: 'absolute', left: `${PAD + shownFrac * usable}px`, top: 3, width: 9, height: 9, marginLeft: -5, transform: 'rotate(45deg)', background: allSel ? '#ffd23f' : anySel ? '#ffe6a0' : '#c3ccdd', border: '1px solid rgba(0,0,0,.6)', boxShadow: allSel ? '0 0 0 1.5px #ffd23f, 0 0 0 3px rgba(255,210,63,.25)' : '0 0 0 1px rgba(255,255,255,.14)', zIndex: allSel || anySel ? 2 : 1, cursor: 'grab' }} />
                    );
                  })}
                </div>
              )}
              {tracks.map((t, ti) => (
                <div key={t.bone} style={{ height: LANE, position: 'relative', background: ti % 2 ? 'rgba(255,255,255,.018)' : 'transparent' }}>
                  {t.keys.map((tick) => {
                    const id = kid(t.bone, tick), selected = keySel.has(id), primary = !!keyDrag && keyDrag.bone === t.bone && keyDrag.from === tick;
                    const moving = !!keyDrag && selected;
                    const origFrac = (tick - lo) / span, shownFrac = moving ? Math.max(0, Math.min(1, origFrac + df)) : origFrac;
                    return (
                      <div key={tick} className="ds-key" title={`tick ${tick} - click to select, shift-click to add, drag to move, right-click to delete`}
                        onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); (e.currentTarget as Element).setPointerCapture(e.pointerId); if (e.shiftKey) { setKeySel((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; }); return; } if (!keySel.has(id)) setKeySel(new Set([id])); const gf = fracAt(e.clientX); setKeyDrag({ bone: t.bone, from: tick, grabFrac: gf, curFrac: gf }); }}
                        onPointerMove={(e) => { if (primary) { if (!(e.buttons & 1)) { setKeyDrag(null); return; } setKeyDrag((kd) => kd ? { ...kd, curFrac: fracAt(e.clientX) } : null); } }}
                        onPointerUp={(e) => { e.stopPropagation(); if (!primary) return; const dt = snap(keyDrag!.from + (keyDrag!.curFrac - keyDrag!.grabFrac) * span) - keyDrag!.from; if (dt !== 0) { const moved = eng.moveKeys(parseSel(keySel), dt); setKeySel(new Set(moved.map((m) => kid(m.bone, m.tick)))); bump(); } setKeyDrag(null); }}
                        onPointerCancel={() => setKeyDrag(null)} onLostPointerCapture={() => { if (primary) setKeyDrag(null); }}
                        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); if (selected && keySel.size > 1) { eng.deleteKeys(parseSel(keySel)); setKeySel(new Set()); } else eng.deleteKey(t.bone, tick); bump(); }}
                        style={{ position: 'absolute', left: `${PAD + shownFrac * usable}px`, top: 3, width: 9, height: 9, marginLeft: -5, transform: 'rotate(45deg)', background: selected ? '#ffd23f' : '#3ec96b', border: '1px solid rgba(0,0,0,.55)', boxShadow: selected ? '0 0 0 1.5px #ffd23f, 0 0 0 3px rgba(255,210,63,.25)' : '0 0 0 1px rgba(255,255,255,.07)', zIndex: selected ? 2 : 1, cursor: 'grab' }} />
                    );
                  })}
                </div>
              ))}
              </>);
            })()}
            {keyBox && <div style={{ position: 'absolute', left: Math.min(keyBox.x0, keyBox.x1), top: Math.min(keyBox.y0, keyBox.y1), width: Math.abs(keyBox.x1 - keyBox.x0), height: Math.abs(keyBox.y1 - keyBox.y0), border: '1px solid var(--accent)', background: 'rgba(91,140,255,.14)', pointerEvents: 'none', zIndex: 4 }} />}
            {!tracks.length && (
              <div style={{ position: 'absolute', left: 0, right: 0, top: 19, bottom: 0, display: 'grid', placeItems: 'center', pointerEvents: 'none' }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 9, fontSize: 11, color: 'var(--muted)', opacity: .85 }}>
                  <span style={{ width: 9, height: 9, transform: 'rotate(45deg)', border: '1.5px solid var(--muted)', borderRadius: 2, opacity: .6 }} />
                  {selOnly ? 'Select a bone to see its keyframes' : 'Pose a bone, scrub, and pose again to add keyframes'}
                </span>
              </div>
            )}
            </div>
          </div>
          <div style={{ position: 'relative', height: 5, marginTop: 3 }}>
            <div ref={thumbRef} title="drag to scroll"
              onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); (e.currentTarget as Element).setPointerCapture(e.pointerId); thumbDragRef.current = { startX: e.clientX, startLeft: scrollRef.current?.scrollLeft ?? 0 }; }}
              onPointerMove={(e) => { const d = thumbDragRef.current, sc = scrollRef.current; if (!d || !sc) return; if (!(e.buttons & 1)) { thumbDragRef.current = null; return; } sc.scrollLeft = d.startLeft + (e.clientX - d.startX) * (sc.scrollWidth / Math.max(1, sc.clientWidth)); }}
              onPointerUp={(e) => { thumbDragRef.current = null; try { (e.currentTarget as Element).releasePointerCapture(e.pointerId); } catch { /* not captured */ } }}
              onPointerCancel={() => { thumbDragRef.current = null; }} onLostPointerCapture={() => { thumbDragRef.current = null; }}
              style={{ position: 'absolute', top: 0, height: 5, width: 0, minWidth: 20, borderRadius: 3, background: 'var(--muted)', opacity: 0.55, cursor: 'grab', display: 'none' }} />
          </div>
        </div>
      </div>
    </div>
  );
}
