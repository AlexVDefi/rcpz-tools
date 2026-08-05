import { useMemo, useRef, useState, useEffect, useLayoutEffect, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

// `label` is what's shown; `search` (optional) is extra haystack text matched by the search box in
// addition to the label - used to keep the raw item/model name searchable when the label is a
// translated display name.
export interface GridItem { key: string; label: string; facet: string; isMod: boolean; source?: string; search?: string; }

const GAP = 8;
const PAD = 8;
const LABEL_H = 40;

// A virtualized grid of asset cards with search, a facet filter, sort, a vanilla/modded
// toggle, and a column-size control (bigger/smaller thumbnails). Cards scale with the
// chosen column count and the panel width, so it stays responsive as the split is dragged.
export function AssetGrid<T extends GridItem>({
  items, facetLabel, active, onPick, renderThumb, facetOrder, extraControls, favActive, onToggleFav, tagsOf, overlay, minRows,
}: {
  items: T[];
  facetLabel: string;
  active: (item: T) => boolean;
  onPick: (item: T) => void;
  renderThumb?: (item: T) => ReactNode;
  facetOrder?: string[];
  extraControls?: ReactNode;
  favActive?: (item: T) => boolean;
  onToggleFav?: (item: T) => void;
  tagsOf?: (item: T) => string[];
  overlay?: (item: T) => ReactNode; // extra per-cell control drawn over the thumbnail (e.g. hand toggle)
  minRows?: number; // floor the scroll area to this many card rows (so it stays usable when stacked under tall pickers); the panel scrolls to reach it
}) {
  const [q, setQ] = useState('');
  const [facet, setFacet] = useState('');
  const [source, setSource] = useState('');
  const [tag, setTag] = useState('');
  const [modOnly, setModOnly] = useState(false);
  const [favOnly, setFavOnly] = useState(false);
  const [sort, setSort] = useState<'name' | 'facet' | 'mod'>('name');
  const [colPref, setColPref] = useState<number>(() => Number(localStorage.getItem('pz-grid-cols')) || 2);
  const [width, setWidth] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  const facets = useMemo(() => {
    const counts = new Map<string, number>();
    for (const it of items) counts.set(it.facet, (counts.get(it.facet) || 0) + 1);
    const rank = (f: string) => { const i = facetOrder?.indexOf(f) ?? -1; return i < 0 ? 999 : i; };
    return [...counts.entries()].sort((a, b) => (rank(a[0]) - rank(b[0])) || a[0].localeCompare(b[0]));
  }, [items, facetOrder]);

  const sources = useMemo(() => {
    const set = new Set<string>();
    for (const it of items) if (it.source) set.add(it.source);
    return [...set].sort((a, b) => (a === 'Vanilla' ? -1 : b === 'Vanilla' ? 1 : a.localeCompare(b)));
  }, [items]);

  const tags = useMemo(() => {
    if (!tagsOf) return [] as [string, number][];
    const counts = new Map<string, number>();
    for (const it of items) for (const t of tagsOf(it)) counts.set(t, (counts.get(t) || 0) + 1);
    return [...counts.entries()].sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]));
  }, [items, tagsOf]);

  const filtered = useMemo(() => {
    const f = q.trim().toLowerCase();
    const rows = items.filter((it) =>
      (!facet || it.facet === facet) && (!modOnly || it.isMod) && (!favOnly || !!favActive?.(it)) && (!source || it.source === source) && (!tag || !!tagsOf?.(it).includes(tag)) && (!f || (it.search || it.label).toLowerCase().includes(f)));
    return rows.slice().sort((a, b) =>
      sort === 'mod' ? (Number(b.isMod) - Number(a.isMod)) || a.label.localeCompare(b.label)
      : sort === 'facet' ? a.facet.localeCompare(b.facet) || a.label.localeCompare(b.label)
      : a.label.localeCompare(b.label));
  }, [items, q, facet, source, tag, tagsOf, modOnly, favOnly, favActive, sort]);

  // Measure BEFORE paint (layout effect) so a fresh mount - e.g. the key={kind} remount when switching
  // hair<->beard - never paints a frame at the width=0 fallback card size (which, with a minRows floor,
  // would flash the whole grid height). The ResizeObserver keeps it in sync on later resizes.
  useLayoutEffect(() => {
    const el = scrollRef.current; if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el); setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  // When a hidden tab pane (display:none, clientWidth 0) is shown again, the parent re-renders (tab
  // changed) so this bare layout effect measures the now-real width synchronously before paint - no
  // one-frame flash at the width=0 fallback card size while the ResizeObserver catches up.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && el.clientWidth && el.clientWidth !== width) setWidth(el.clientWidth);
  });

  const setCols = (n: number) => { setColPref(n); localStorage.setItem('pz-grid-cols', String(n)); };
  const cols = Math.max(1, colPref);
  const cardW = width ? Math.floor((width - PAD * 2 - (cols - 1) * GAP) / cols) : 120;
  const rowH = cardW + LABEL_H;
  const rowCount = Math.ceil(filtered.length / cols);
  const rowVirt = useVirtualizer({ count: rowCount, getScrollElement: () => scrollRef.current, estimateSize: () => rowH + GAP, overscan: 3 });
  // the estimateSize closure changes when card size changes (panel drag / column count);
  // force the virtualizer to recompute row positions so the layout reflows live
  useEffect(() => { rowVirt.measure(); }, [rowH, cols, rowVirt]);

  const inputStyle = { background: '#14141a', color: 'var(--text)', border: '1px solid var(--line)', borderRadius: 6, padding: '6px 8px' } as const;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
      <div style={{ padding: 8, borderBottom: '1px solid var(--line)', display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${items.length}…`} style={{ ...inputStyle, flex: '1 1 120px', minWidth: 90 }} />
        <select value={facet} onChange={(e) => setFacet(e.target.value)} style={inputStyle}>
          <option value="">all {facetLabel} ({items.length})</option>
          {facets.map(([f, n]) => <option key={f} value={f}>{f} ({n})</option>)}
        </select>
        {sources.length > 1 && (
          <select value={source} onChange={(e) => setSource(e.target.value)} style={inputStyle} title="filter by mod">
            <option value="">all sources</option>
            {sources.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        )}
        {tags.length > 0 && (
          <select value={tag} onChange={(e) => setTag(e.target.value)} style={inputStyle} title="filter by tag">
            <option value="">all tags</option>
            {tags.map(([t, n]) => <option key={t} value={t}>{t} ({n})</option>)}
          </select>
        )}
        <select value={sort} onChange={(e) => setSort(e.target.value as 'name' | 'facet' | 'mod')} style={inputStyle}>
          <option value="name">sort: name</option>
          <option value="facet">sort: {facetLabel}</option>
          <option value="mod">sort: mod first</option>
        </select>
        <button className="secondary" onClick={() => setModOnly((v) => !v)} style={{ padding: '6px 10px', background: modOnly ? 'var(--accent)' : 'var(--panel)', color: modOnly ? '#fff' : 'var(--text)' }}>modded</button>
        {onToggleFav && (
          <button className="secondary" onClick={() => setFavOnly((v) => !v)} title="show favorites only"
            style={{ padding: '6px 10px', background: favOnly ? 'var(--accent)' : 'var(--panel)', color: favOnly ? '#fff' : '#f5c518' }}>★</button>
        )}
        {extraControls}
        <div style={{ display: 'flex', border: '1px solid var(--line)', borderRadius: 6, overflow: 'hidden', marginLeft: 'auto' }} title="thumbnail size">
          {[1, 2, 3, 4].map((n) => (
            <button key={n} className="secondary" onClick={() => setCols(n)}
              style={{ borderRadius: 0, padding: '6px 9px', background: cols === n ? 'var(--accent)' : 'var(--panel)', color: cols === n ? '#fff' : 'var(--muted)' }}>{n}</button>
          ))}
        </div>
      </div>

      <div ref={scrollRef} style={{ overflow: 'auto', flex: 1, padding: PAD, minHeight: minRows ? minRows * (rowH + GAP) + PAD * 2 : undefined }}>
        <div style={{ height: rowVirt.getTotalSize(), position: 'relative' }}>
          {rowVirt.getVirtualItems().map((vr) => {
            const start = vr.index * cols;
            const rowItems = filtered.slice(start, start + cols);
            return (
              <div key={vr.key} style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vr.start}px)`, height: rowH, display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: GAP }}>
                {rowItems.map((it) => {
                  const on = active(it);
                  return (
                    <button key={it.key} onClick={() => onPick(it)} title={it.label}
                      style={{ all: 'unset', cursor: 'pointer', border: `1px solid ${on ? 'var(--accent)' : 'var(--line)'}`, background: on ? '#5b8cff22' : '#14141a', borderRadius: 8, overflow: 'hidden', display: 'flex', flexDirection: 'column', height: rowH, boxSizing: 'border-box' }}>
                      <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#101014', position: 'relative' }}>
                        {renderThumb ? renderThumb(it) : <span style={{ color: '#3a3a44', fontSize: 26 }}>◻</span>}
                        {onToggleFav && (
                          <span role="button" title="favorite" onClick={(e) => { e.stopPropagation(); onToggleFav(it); }}
                            style={{ position: 'absolute', top: 2, left: 4, fontSize: 18, lineHeight: 1, cursor: 'pointer', color: favActive?.(it) ? '#f5c518' : '#ffffff66', textShadow: '0 1px 2px #000' }}>
                            {favActive?.(it) ? '★' : '☆'}
                          </span>
                        )}
                        {it.isMod && <span style={{ position: 'absolute', top: 4, right: 4, background: '#2e7d32cc', color: '#fff', fontSize: 9, padding: '1px 4px', borderRadius: 3 }}>MOD</span>}
                        {overlay?.(it)}
                      </div>
                      <div style={{ padding: '5px 7px', borderTop: '1px solid var(--line)', height: LABEL_H, boxSizing: 'border-box' }}>
                        <div style={{ fontSize: 11, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.label}</div>
                        <div style={{ fontSize: 10, color: 'var(--muted)' }}>{it.facet}</div>
                      </div>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
        {!filtered.length && <div style={{ color: 'var(--muted)', padding: 20, textAlign: 'center' }}>No matches.</div>}
      </div>
      <div style={{ padding: '4px 10px', borderTop: '1px solid var(--line)', color: 'var(--muted)', fontSize: 11 }}>{filtered.length} of {items.length}</div>
    </div>
  );
}
