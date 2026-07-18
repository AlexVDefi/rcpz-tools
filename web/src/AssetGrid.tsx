import { useMemo, useRef, useState, useEffect, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

export interface GridItem { key: string; label: string; facet: string; isMod: boolean; }

// A virtualized grid of asset cards with search, a facet filter, sort, and a
// vanilla/modded toggle — the replacement for the old capped flat list. Thumbnails are
// rendered lazily into each card via `renderThumb` (async, cached by the caller).
export function AssetGrid<T extends GridItem>({
  items, facetLabel, active, onPick, renderThumb, cardHeight = 132, minCard = 116, facetOrder,
}: {
  items: T[];
  facetLabel: string;
  active: (item: T) => boolean;
  onPick: (item: T) => void;
  renderThumb?: (item: T) => ReactNode;
  cardHeight?: number;
  minCard?: number;
  facetOrder?: string[];
}) {
  const [q, setQ] = useState('');
  const [facet, setFacet] = useState('');
  const [modOnly, setModOnly] = useState(false);
  const [sort, setSort] = useState<'name' | 'facet' | 'mod'>('name');
  const scrollRef = useRef<HTMLDivElement>(null);
  const [cols, setCols] = useState(3);

  const facets = useMemo(() => {
    const counts = new Map<string, number>();
    for (const it of items) counts.set(it.facet, (counts.get(it.facet) || 0) + 1);
    const rank = (f: string) => { const i = facetOrder?.indexOf(f) ?? -1; return i < 0 ? 999 : i; };
    return [...counts.entries()].sort((a, b) => (rank(a[0]) - rank(b[0])) || a[0].localeCompare(b[0]));
  }, [items, facetOrder]);

  const filtered = useMemo(() => {
    const f = q.trim().toLowerCase();
    let rows = items.filter((it) =>
      (!facet || it.facet === facet) && (!modOnly || it.isMod) && (!f || it.label.toLowerCase().includes(f)));
    rows = rows.slice().sort((a, b) =>
      sort === 'mod' ? (Number(b.isMod) - Number(a.isMod)) || a.label.localeCompare(b.label)
      : sort === 'facet' ? a.facet.localeCompare(b.facet) || a.label.localeCompare(b.label)
      : a.label.localeCompare(b.label));
    return rows;
  }, [items, q, facet, modOnly, sort]);

  // responsive column count
  useEffect(() => {
    const el = scrollRef.current; if (!el) return;
    const ro = new ResizeObserver(() => setCols(Math.max(1, Math.floor(el.clientWidth / minCard))));
    ro.observe(el);
    return () => ro.disconnect();
  }, [minCard]);

  const rowCount = Math.ceil(filtered.length / cols);
  const rowVirt = useVirtualizer({ count: rowCount, getScrollElement: () => scrollRef.current, estimateSize: () => cardHeight, overscan: 4 });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
      <div style={{ padding: 8, borderBottom: '1px solid var(--line)', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${items.length}…`}
          style={{ flex: '1 1 120px', minWidth: 100, background: '#14141a', color: 'var(--text)', border: '1px solid var(--line)', borderRadius: 6, padding: '6px 8px' }} />
        <select value={facet} onChange={(e) => setFacet(e.target.value)}
          style={{ background: '#14141a', color: 'var(--text)', border: '1px solid var(--line)', borderRadius: 6, padding: '6px 8px' }}>
          <option value="">all {facetLabel} ({items.length})</option>
          {facets.map(([f, n]) => <option key={f} value={f}>{f} ({n})</option>)}
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value as 'name' | 'facet' | 'mod')}
          style={{ background: '#14141a', color: 'var(--text)', border: '1px solid var(--line)', borderRadius: 6, padding: '6px 8px' }}>
          <option value="name">sort: name</option>
          <option value="facet">sort: {facetLabel}</option>
          <option value="mod">sort: mod first</option>
        </select>
        <button className="secondary" onClick={() => setModOnly((v) => !v)}
          style={{ padding: '6px 10px', background: modOnly ? 'var(--accent)' : 'var(--panel)', color: modOnly ? '#fff' : 'var(--text)' }}>
          modded
        </button>
      </div>

      <div ref={scrollRef} style={{ overflow: 'auto', flex: 1, padding: 8 }}>
        <div style={{ height: rowVirt.getTotalSize(), position: 'relative' }}>
          {rowVirt.getVirtualItems().map((vr) => {
            const start = vr.index * cols;
            const rowItems = filtered.slice(start, start + cols);
            return (
              <div key={vr.key} style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vr.start}px)`, height: vr.size, display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 8 }}>
                {rowItems.map((it) => {
                  const on = active(it);
                  return (
                    <button key={it.key} onClick={() => onPick(it)} title={it.label}
                      style={{ all: 'unset', cursor: 'pointer', border: `1px solid ${on ? 'var(--accent)' : 'var(--line)'}`, background: on ? '#5b8cff22' : '#14141a', borderRadius: 8, overflow: 'hidden', display: 'flex', flexDirection: 'column', height: cardHeight - 8 }}>
                      <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#101014', position: 'relative' }}>
                        {renderThumb ? renderThumb(it) : <span style={{ color: '#3a3a44', fontSize: 26 }}>◻</span>}
                        {it.isMod && <span style={{ position: 'absolute', top: 4, right: 4, background: '#2e7d32cc', color: '#fff', fontSize: 9, padding: '1px 4px', borderRadius: 3 }}>MOD</span>}
                      </div>
                      <div style={{ padding: '5px 7px', borderTop: '1px solid var(--line)' }}>
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
      <div style={{ padding: '4px 10px', borderTop: '1px solid var(--line)', color: 'var(--muted)', fontSize: 11 }}>
        {filtered.length} of {items.length}
      </div>
    </div>
  );
}
