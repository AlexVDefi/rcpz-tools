import { useMemo, useRef, useState, useEffect, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

export interface GridItem { key: string; label: string; facet: string; isMod: boolean; }

const GAP = 8;
const PAD = 8;
const LABEL_H = 40;

// A virtualized grid of asset cards with search, a facet filter, sort, a vanilla/modded
// toggle, and a column-size control (bigger/smaller thumbnails). Cards scale with the
// chosen column count and the panel width, so it stays responsive as the split is dragged.
export function AssetGrid<T extends GridItem>({
  items, facetLabel, active, onPick, renderThumb, facetOrder, extraControls,
}: {
  items: T[];
  facetLabel: string;
  active: (item: T) => boolean;
  onPick: (item: T) => void;
  renderThumb?: (item: T) => ReactNode;
  facetOrder?: string[];
  extraControls?: ReactNode;
}) {
  const [q, setQ] = useState('');
  const [facet, setFacet] = useState('');
  const [modOnly, setModOnly] = useState(false);
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

  const filtered = useMemo(() => {
    const f = q.trim().toLowerCase();
    const rows = items.filter((it) =>
      (!facet || it.facet === facet) && (!modOnly || it.isMod) && (!f || it.label.toLowerCase().includes(f)));
    return rows.slice().sort((a, b) =>
      sort === 'mod' ? (Number(b.isMod) - Number(a.isMod)) || a.label.localeCompare(b.label)
      : sort === 'facet' ? a.facet.localeCompare(b.facet) || a.label.localeCompare(b.label)
      : a.label.localeCompare(b.label));
  }, [items, q, facet, modOnly, sort]);

  useEffect(() => {
    const el = scrollRef.current; if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el); setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

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
        <select value={sort} onChange={(e) => setSort(e.target.value as 'name' | 'facet' | 'mod')} style={inputStyle}>
          <option value="name">sort: name</option>
          <option value="facet">sort: {facetLabel}</option>
          <option value="mod">sort: mod first</option>
        </select>
        <button className="secondary" onClick={() => setModOnly((v) => !v)} style={{ padding: '6px 10px', background: modOnly ? 'var(--accent)' : 'var(--panel)', color: modOnly ? '#fff' : 'var(--text)' }}>modded</button>
        {extraControls}
        <div style={{ display: 'flex', border: '1px solid var(--line)', borderRadius: 6, overflow: 'hidden', marginLeft: 'auto' }} title="thumbnail size">
          {[1, 2, 3, 4].map((n) => (
            <button key={n} className="secondary" onClick={() => setCols(n)}
              style={{ borderRadius: 0, padding: '6px 9px', background: cols === n ? 'var(--accent)' : 'var(--panel)', color: cols === n ? '#fff' : 'var(--muted)' }}>{n}</button>
          ))}
        </div>
      </div>

      <div ref={scrollRef} style={{ overflow: 'auto', flex: 1, padding: PAD }}>
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
                        {it.isMod && <span style={{ position: 'absolute', top: 4, right: 4, background: '#2e7d32cc', color: '#fff', fontSize: 9, padding: '1px 4px', borderRadius: 3 }}>MOD</span>}
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
