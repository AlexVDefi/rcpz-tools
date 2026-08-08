import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CharacterEngine } from './render/character-engine';

export const keyId = (b: string, t: number) => b + '@' + t; // dopesheet keyframe selection id
export const parseKeySel = (s: Set<string>) => [...s].map((id) => { const i = id.lastIndexOf('@'); return { bone: id.slice(0, i), tick: +id.slice(i + 1) }; });

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
};

export function Dopesheet({ engine, boneTick, bump, keySel, setKeySel, scrubbingRef, playheadRef, trackGeomRef, onToast }: DopesheetProps) {
  const [zoom, setZoom] = useState(1);            // horizontal zoom (1 = fit)
  const [selOnly, setSelOnly] = useState(false);  // only show tracks for the selected bone(s)
  const [autoKey, setAutoKey] = useState(() => engine.autoKeyOn());       // posing writes a key at the current time
  const [autoEnds, setAutoEnds] = useState(() => engine.autoEndpointsOn()); // first edit of a bone keys the first + last frame
  const [keyDrag, setKeyDrag] = useState<{ bone: string; from: number; grabFrac: number; curFrac: number } | null>(null); // a keyframe (group) being dragged
  const [keyBox, setKeyBox] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null); // rubber-band box (ruler-local px)
  const scrollRef = useRef<HTMLDivElement>(null);   // horizontal scroll viewport
  const rulerRef = useRef<HTMLDivElement>(null);    // track area, for mapping cursor x to a tick
  const thumbRef = useRef<HTMLDivElement>(null);    // custom slim scrollbar thumb
  const thumbDragRef = useRef<{ startX: number; startLeft: number } | null>(null);
  const panRef = useRef<{ startX: number; startLeft: number } | null>(null); // middle-mouse drag pan
  const boxRef = useRef<{ x0: number; y0: number } | null>(null);
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

  void boneTick; const eng = engine;
  const tl = eng.keyframeTimeline(); const [lo, hi] = tl.range; const span = Math.max(1, hi - lo);
  const frames = tl.frames;
  const baseWidth = Math.max(140, frames.length * 14); baseWidthRef.current = baseWidth; // px timeline width at zoom 1
  const innerW = baseWidth * zoom;
  const PAD = 6, usable = Math.max(1, innerW - 2 * PAD); trackGeomRef.current = { pad: PAD, usable }; // inset so edge diamonds/labels stay inside the track (no overflow -> no scrollbar)
  const clampZoom = (z: number) => Math.max(0.02, Math.min(40, +z.toFixed(3)));
  const doFit = () => { const cw = scrollRef.current?.clientWidth; if (cw) { pendingScrollRef.current = 0; setZoom(Math.max(0.02, (cw - 2) / baseWidth)); requestAnimationFrame(updateThumb); } }; // -2px so the timeline never overflows; refresh the thumb even if zoom is unchanged
  const kid = keyId, parseSel = parseKeySel;
  const selDriven = selOnly ? new Set(eng.affectedForSelection()) : null; // a handle drives a whole chain, so filter by driven bones
  const tracks = selDriven ? tl.tracks.filter((t) => selDriven.has(t.bone)) : tl.tracks;
  const xPct = (tick: number) => `${PAD + ((tick - lo) / span) * usable}px`;
  const fracAt = (clientX: number) => { const r = rulerRef.current?.getBoundingClientRect(); return r && r.width > 0 ? Math.max(0, Math.min(1, (clientX - r.left - PAD) / usable)) : 0; };
  const snap = (tick: number) => frames.length ? frames.reduce((best, f) => Math.abs(f - tick) < Math.abs(best - tick) ? f : best, frames[0]) : Math.round(tick);
  const tickAt = (clientX: number) => snap(lo + fracAt(clientX) * span);
  const mono = 'ui-monospace,SFMono-Regular,Menlo,monospace';
  const pxPerFrame = frames.length ? innerW / frames.length : innerW;
  const gridStep = Math.max(1, Math.ceil(6 / Math.max(0.01, pxPerFrame)));           // keep >= ~6px between drawn frame lines
  const labelStep = gridStep * Math.max(1, Math.round(48 / (pxPerFrame * gridStep))); // a frame number roughly every 48px
  return (
    <div style={{ padding: '8px 10px 9px', borderBottom: '1px solid rgba(255,255,255,.07)', userSelect: 'none', WebkitUserSelect: 'none' }}>
      <style>{`
        .ds-title{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.12em;color:var(--muted)}
        .ds-chip{font-size:9.5px;font-weight:600;color:var(--muted);font-variant-numeric:tabular-nums;font-family:${mono};padding:2px 7px;border:1px solid rgba(255,255,255,.1);border-radius:20px}
        .ds-btn{height:23px;padding:0 10px;font-size:11px;font-weight:500;border-radius:6px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.02);color:var(--text);cursor:pointer;display:inline-flex;align-items:center;white-space:nowrap;transition:background .12s,border-color .12s,transform .05s,filter .12s}
        .ds-btn:hover{background:rgba(255,255,255,.07);border-color:rgba(255,255,255,.2)}
        .ds-btn:active{transform:translateY(1px)}
        .ds-btn[data-on]{background:var(--accent);border-color:transparent;color:#fff}
        .ds-btn[data-primary]{background:var(--accent);border-color:transparent;color:#fff;font-weight:600}
        .ds-btn[data-on]:hover,.ds-btn[data-primary]:hover{filter:brightness(1.12);background:var(--accent);border-color:transparent}
        .ds-seg{display:inline-flex;align-items:center;height:23px;border:1px solid rgba(255,255,255,.12);border-radius:6px;overflow:hidden;background:rgba(255,255,255,.02)}
        .ds-seg>button{border:0;background:transparent;color:var(--text);cursor:pointer;height:100%;width:25px;font-size:15px;line-height:1;display:grid;place-items:center;transition:background .12s}
        .ds-seg>button:hover{background:rgba(255,255,255,.09)}
        .ds-seg>button:active{transform:translateY(1px)}
        .ds-seg>.val{min-width:50px;padding:0 4px;text-align:center;font-size:11px;color:var(--muted);font-variant-numeric:tabular-nums;font-family:${mono};border-left:1px solid rgba(255,255,255,.1);border-right:1px solid rgba(255,255,255,.1)}
        .ds-key{transition:transform .08s ease}
        .ds-key:hover{transform:rotate(45deg) scale(1.3)!important;z-index:2}
        .ds-scroll::-webkit-scrollbar{display:none}
      `}</style>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 7 }}>
        <span className="ds-title">Dopesheet</span>
        <span className="ds-chip">{frames.length} fr</span>
        <span style={{ fontSize: 10, color: 'var(--muted)', marginLeft: 2 }}>length</span>
        <span className="ds-seg" title="Retime the whole clip - stretch or squash its total length (rescales the timing and every keyframe)">
          <button title="Shorter" aria-label="Shorter" onClick={() => { eng.setLengthScale(tl.lengthScale / 1.25); bump(); }}>-</button>
          <span className="val">{tl.lengthScale.toFixed(2)}x</span>
          <button title="Longer" aria-label="Longer" onClick={() => { eng.setLengthScale(tl.lengthScale * 1.25); bump(); }}>+</button>
        </span>
        <span style={{ fontSize: 10, color: 'var(--muted)', marginLeft: 2 }}>end</span>
        <span className="ds-seg" title="Trim or extend the clip end by one frame (cut the tail, or hold the last pose)">
          <button title="Trim a frame" aria-label="Trim a frame" onClick={() => { eng.nudgeClipEnd(-1); bump(); }}>-</button>
          <span className="val">{(() => { const step = tl.frameCount > 1 ? (tl.scaledEnd - tl.range[0]) / (tl.frameCount - 1) : 1; return tl.clipEnd != null ? Math.max(2, Math.round((tl.clipEnd - tl.range[0]) / step) + 1) : tl.frameCount; })()} fr</span>
          <button title="Extend a frame" aria-label="Extend a frame" onClick={() => { eng.nudgeClipEnd(1); bump(); }}>+</button>
        </span>
        {tl.clipEnd != null && <button className="ds-btn" title="Reset to full length" onClick={() => { eng.setClipEnd(null); bump(); }}>full</button>}
        <span style={{ flex: 1 }} />
        <button className="ds-btn" data-on={selOnly || undefined} title="Only show tracks for the selected bone" onClick={() => setSelOnly((v) => !v)}>selected only</button>
        <button className="ds-btn" title="Fit all frames in view" onClick={doFit}>fit</button>
        <span className="ds-seg">
          <button title="Zoom out" aria-label="Zoom out" onClick={() => setZoom((z) => clampZoom(z / 1.6))}>-</button>
          <span className="val">{zoom < 1 ? zoom.toFixed(2) : zoom.toFixed(1)}x</span>
          <button title="Zoom in" aria-label="Zoom in" onClick={() => setZoom((z) => clampZoom(z * 1.6))}>+</button>
        </span>
        <button className="ds-btn" data-on={autoKey || undefined} title="When on, posing a bone writes/updates a keyframe at the current time" onClick={() => { const n = !autoKey; setAutoKey(n); eng.setAutoKey(n); }}>auto-key</button>
        <button className="ds-btn" data-on={autoEnds || undefined} title="When on, the first edit of a bone also drops rest keyframes at the first and last frames" onClick={() => { const n = !autoEnds; setAutoEnds(n); eng.setAutoEndpoints(n); }}>auto-ends</button>
        <button className="ds-btn" data-primary="true" title="Key the current pose of the selected and edited bones at this time" onClick={() => { eng.addKeyAtCurrent(); bump(); }}>+ key</button>
      </div>
      {keySel.size > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 7 }}>
          <span className="ds-chip" style={{ borderColor: 'rgba(255,210,63,.45)', color: '#ffd23f' }}>{keySel.size} key{keySel.size === 1 ? '' : 's'} selected</span>
          <span style={{ flex: 1 }} />
          <button className="ds-btn" title="Copy the selected keyframes" onClick={() => { const n = eng.copyKeys(parseSel(keySel)); onToast(`copied ${n} keyframe${n === 1 ? '' : 's'}`); }}>copy</button>
          <button className="ds-btn" disabled={!eng.keyClipboardSize()} title="Paste copied keyframes at the playhead" onClick={() => { const p = eng.pasteKeysAt(eng.currentTick()); setKeySel(new Set(p.map((m) => kid(m.bone, m.tick)))); bump(); }}>paste at playhead</button>
          <button className="ds-btn" title="Delete the selected keyframes" onClick={() => { eng.deleteKeys(parseSel(keySel)); setKeySel(new Set()); bump(); }}>delete</button>
          <button className="ds-btn" title="Clear selection" onClick={() => setKeySel(new Set())}>clear</button>
        </div>
      )}
      <div style={{ display: 'flex', gap: 6 }}>
        <div style={{ width: 66, flexShrink: 0 }}>
          <div style={{ height: 19 }} />
          {tracks.map((t) => <div key={t.bone} title={t.bone} style={{ height: 15, fontSize: 10.5, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', lineHeight: '15px' }}>{t.bone.replace(/^Bip01_?/, '')}</div>)}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div ref={scrollRef} className="ds-scroll" onScroll={updateThumb} style={{ overflowX: 'scroll', overflowY: 'hidden', scrollbarWidth: 'none' }}>
            <div ref={rulerRef} style={{ position: 'relative', width: `${innerW}px`, minHeight: tracks.length ? undefined : 56, overflow: 'hidden', cursor: 'ew-resize', touchAction: 'none' }}
            onMouseDown={(e) => e.preventDefault()} // no text selection / focus, and kills middle-click autoscroll
            onPointerDown={(e) => {
              if (e.button === 1) { (e.currentTarget as Element).setPointerCapture(e.pointerId); panRef.current = { startX: e.clientX, startLeft: scrollRef.current?.scrollLeft ?? 0 }; return; }
              if (e.button !== 0) return; (e.currentTarget as Element).setPointerCapture(e.pointerId);
              if (e.shiftKey) { const r = rulerRef.current!.getBoundingClientRect(); const x = e.clientX - r.left, y = e.clientY - r.top; boxRef.current = { x0: x, y0: y }; setKeyBox({ x0: x, y0: y, x1: x, y1: y }); return; } // shift-drag = rubber-band select
              setKeySel(new Set()); scrubbingRef.current = true; eng.seekTick(tickAt(e.clientX));
            }}
            onPointerMove={(e) => {
              if (boxRef.current) { const r = rulerRef.current!.getBoundingClientRect(); setKeyBox({ x0: boxRef.current.x0, y0: boxRef.current.y0, x1: e.clientX - r.left, y1: e.clientY - r.top }); return; }
              if (panRef.current) { if (!(e.buttons & 4)) { panRef.current = null; return; } if (scrollRef.current) scrollRef.current.scrollLeft = panRef.current.startLeft - (e.clientX - panRef.current.startX); return; }
              if (scrubbingRef.current) { if (!(e.buttons & 1)) { scrubbingRef.current = false; return; } eng.seekTick(tickAt(e.clientX)); }
            }}
            onPointerUp={(e) => {
              if (boxRef.current) {
                const r = rulerRef.current!.getBoundingClientRect(), x1 = e.clientX - r.left, y1 = e.clientY - r.top;
                const minX = Math.min(boxRef.current.x0, x1), maxX = Math.max(boxRef.current.x0, x1), minY = Math.min(boxRef.current.y0, y1), maxY = Math.max(boxRef.current.y0, y1);
                const picked = new Set<string>();
                tracks.forEach((t, ti) => { const top = 19 + ti * 15, bot = top + 15; if (bot < minY || top > maxY) return; for (const tick of t.keys) { const x = PAD + ((tick - lo) / span) * usable; if (x >= minX && x <= maxX) picked.add(kid(t.bone, tick)); } });
                setKeySel((prev) => new Set([...prev, ...picked])); boxRef.current = null; setKeyBox(null);
              }
              scrubbingRef.current = false; panRef.current = null; try { (e.currentTarget as Element).releasePointerCapture(e.pointerId); } catch { /* not captured */ }
            }}
            onPointerCancel={() => { scrubbingRef.current = false; panRef.current = null; boxRef.current = null; setKeyBox(null); }}
            onLostPointerCapture={() => { scrubbingRef.current = false; panRef.current = null; boxRef.current = null; setKeyBox(null); }}>
            {frames.filter((_, i) => i % gridStep === 0).map((f, i) => {
              const major = (i * gridStep) % labelStep === 0;
              return (
                <div key={f} style={{ position: 'absolute', left: xPct(f), top: major ? 0 : 19, bottom: 0, width: 1, marginLeft: -0.5, background: major ? 'rgba(255,255,255,.13)' : 'rgba(255,255,255,.05)', pointerEvents: 'none', zIndex: 0 }}>
                  {major && <span style={{ position: 'absolute', top: 4, left: 3, fontSize: 9, color: 'var(--muted)', fontFamily: mono, fontVariantNumeric: 'tabular-nums', pointerEvents: 'none' }}>{i * gridStep}</span>}
                </div>
              );
            })}
            <div ref={playheadRef} style={{ position: 'absolute', top: 0, bottom: 0, width: 2, marginLeft: -1, background: 'var(--accent)', pointerEvents: 'none', zIndex: 3 }}>
              <div style={{ position: 'absolute', top: 0, left: '50%', transform: 'translateX(-50%)', width: 0, height: 0, borderLeft: '4px solid transparent', borderRight: '4px solid transparent', borderTop: '5px solid var(--accent)' }} />
            </div>
            <div style={{ height: 19, borderBottom: '1px solid rgba(255,255,255,.09)', background: 'rgba(255,255,255,.015)' }} />
            {(() => { const df = keyDrag ? keyDrag.curFrac - keyDrag.grabFrac : 0; return tracks.map((t, ti) => (
              <div key={t.bone} style={{ height: 15, position: 'relative', background: ti % 2 ? 'rgba(255,255,255,.018)' : 'transparent' }}>
                {t.keys.map((tick) => {
                  const id = kid(t.bone, tick), selected = keySel.has(id), primary = keyDrag && keyDrag.bone === t.bone && keyDrag.from === tick;
                  const moving = !!keyDrag && selected;
                  const origFrac = (tick - lo) / span, shownFrac = moving ? Math.max(0, Math.min(1, origFrac + df)) : origFrac;
                  return (
                    <div key={tick} className="ds-key" title={`tick ${tick} - click to select, shift-click to add, drag to move, right-click to delete`}
                      onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); (e.currentTarget as Element).setPointerCapture(e.pointerId); if (e.shiftKey) { setKeySel((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; }); return; } if (!keySel.has(id)) setKeySel(new Set([id])); const gf = fracAt(e.clientX); setKeyDrag({ bone: t.bone, from: tick, grabFrac: gf, curFrac: gf }); }}
                      onPointerMove={(e) => { if (primary) { if (!(e.buttons & 1)) { setKeyDrag(null); return; } setKeyDrag((kd) => kd ? { ...kd, curFrac: fracAt(e.clientX) } : null); } }}
                      onPointerUp={(e) => { e.stopPropagation(); if (!primary) return; const dt = snap(keyDrag!.from + (keyDrag!.curFrac - keyDrag!.grabFrac) * span) - keyDrag!.from; if (dt !== 0) { const moved = eng.moveKeys(parseSel(keySel), dt); setKeySel(new Set(moved.map((m) => kid(m.bone, m.tick)))); bump(); } else eng.seekTick(tick); setKeyDrag(null); }}
                      onPointerCancel={() => setKeyDrag(null)} onLostPointerCapture={() => { if (primary) setKeyDrag(null); }}
                      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); if (selected && keySel.size > 1) { eng.deleteKeys(parseSel(keySel)); setKeySel(new Set()); } else eng.deleteKey(t.bone, tick); bump(); }}
                      style={{ position: 'absolute', left: `${PAD + shownFrac * usable}px`, top: 3, width: 9, height: 9, marginLeft: -5, transform: 'rotate(45deg)', background: selected ? '#ffd23f' : '#3ec96b', border: '1px solid rgba(0,0,0,.55)', boxShadow: selected ? '0 0 0 1.5px #ffd23f, 0 0 0 3px rgba(255,210,63,.25)' : '0 0 0 1px rgba(255,255,255,.07)', zIndex: selected ? 2 : 1, cursor: 'grab' }} />
                  );
                })}
              </div>
            )); })()}
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
