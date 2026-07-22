// Shared tabbed mods browser used by both the studio overview (community-hosted / locally-installed
// mods) and the Modders dashboard (a modder's own Workshop mods). Each tab supplies a normalized
// item list plus its own toggle / bulk-set handlers; the browser adds search, an enabled/disabled
// filter, grid or list view, select/deselect-all, and pagination. Card design is identical
// everywhere so the three surfaces look the same.
import { useState, useEffect, type ReactNode } from 'react';

// Absolute-fill so the thumbnail box keeps its own aspect ratio (the image, being out of flow,
// can't stretch the box to its natural height); `contain` shows the whole poster, letterboxed.
const FILL = { position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain', display: 'block' } as const;
const FILL_PLACEHOLDER = { position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: '#3a3a44' } as const;

const GRID_PER_PAGE = 8;  // 2 rows of 4, so the pager stays in view without scrolling
const LIST_PER_PAGE = 10; // compact rows fit more per page

export type ModItem = {
  id: string;
  title: string;
  author?: string | null;
  enabled: boolean;
  preview?: string | null;          // hosted preview URL (community / Workshop)
  poster?: FileSystemFileHandle;    // local mod poster/icon file
  busy?: boolean;                   // per-card pending (e.g. saving a permission change)
};
export type ModTab = {
  key: string;
  label: string;
  items: ModItem[];
  onToggle: (id: string) => void;
  onSetMany?: (ids: string[], enabled: boolean) => void; // present => show Select all / Deselect all
  onLabel?: string;   // filter wording for enabled items, default "Enabled"
  offLabel?: string;  // filter wording for disabled items, default "Disabled"
  note?: ReactNode;
  controls?: ReactNode;
  empty?: ReactNode;
};

// Thumbnail for a locally-loaded mod: reads its poster/icon file into an object URL, revoked on unmount.
function LocalPoster({ handle }: { handle?: FileSystemFileHandle }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let dead = false; let made: string | null = null;
    if (handle) handle.getFile().then((f) => { if (dead) return; made = URL.createObjectURL(f); setUrl(made); }).catch(() => {});
    else setUrl(null);
    return () => { dead = true; if (made) URL.revokeObjectURL(made); };
  }, [handle]);
  return url
    ? <img src={url} alt="" loading="lazy" style={FILL} />
    : <div style={FILL_PLACEHOLDER}>◈</div>;
}

// Thumbnail for a mod card: a hosted preview URL, a local poster handle, or a placeholder. Must sit
// inside a position:relative box (the grid/list thumbnail wrappers) - the image fills it absolutely.
export function ModThumb({ preview, poster }: { preview?: string | null; poster?: FileSystemFileHandle }) {
  if (preview) return <img src={preview} alt="" loading="lazy" style={FILL} />;
  if (poster) return <LocalPoster handle={poster} />;
  return <div style={FILL_PLACEHOLDER}>◈</div>;
}

export function ModsPanel({ tabs, busy }: { tabs: ModTab[]; busy: boolean }) {
  const [active, setActive] = useState(0);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'on' | 'off'>('all');
  const [view, setView] = useState<'grid' | 'list'>(() => (localStorage.getItem('pz-mods-view') === 'list' ? 'list' : 'grid'));
  const [page, setPage] = useState(0);
  const idx = Math.min(active, tabs.length - 1);
  const tab = tabs[idx];
  const items = tab.items;
  const perPage = view === 'grid' ? GRID_PER_PAGE : LIST_PER_PAGE;
  useEffect(() => { setPage(0); }, [idx, query, filter, items.length, perPage]); // any of these invalidates the current page
  const chooseView = (v: 'grid' | 'list') => { setView(v); localStorage.setItem('pz-mods-view', v); };

  const q = query.trim().toLowerCase();
  const enabledCount = items.filter((m) => m.enabled).length;
  const onLabel = tab.onLabel ?? 'Enabled';
  const offLabel = tab.offLabel ?? 'Disabled';
  const filtered = items.filter((m) => {
    if (filter === 'on' && !m.enabled) return false;
    if (filter === 'off' && m.enabled) return false;
    return !q || `${m.title} ${m.author || ''}`.toLowerCase().includes(q);
  });
  const pages = Math.max(1, Math.ceil(filtered.length / perPage));
  const p = Math.min(page, pages - 1);
  const shown = filtered.slice(p * perPage, p * perPage + perPage);
  const inputStyle = { padding: '7px 10px', fontSize: 12.5, background: '#14141a', border: '1px solid var(--line)', borderRadius: 7, color: 'var(--text)' } as const;
  const cardBusy = (m: ModItem) => busy || !!m.busy;

  return (
    <div style={{ marginTop: 14, borderTop: '1px solid var(--line)', paddingTop: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 4 }}>
          {tabs.map((t, i) => (
            <button key={t.key} onClick={() => setActive(i)} style={{
              padding: '6px 12px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', borderRadius: 7,
              background: i === idx ? 'var(--accent)' : 'transparent', color: i === idx ? '#fff' : 'var(--muted)',
              border: `1px solid ${i === idx ? 'var(--accent)' : 'var(--line)'}`,
            }}>{t.label} <span style={{ opacity: 0.7, fontWeight: 400 }}>{t.items.length}</span></button>
          ))}
        </div>
        {tab.controls && <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>{tab.controls}</span>}
      </div>
      {tab.note && <div style={{ color: 'var(--muted)', fontSize: 12, margin: '9px 0 0', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>{tab.note}</div>}

      {items.length === 0 ? (
        <div style={{ marginTop: 11 }}>{tab.empty}</div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 8, margin: '11px 0', flexWrap: 'wrap', alignItems: 'center' }}>
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name or author" style={{ ...inputStyle, flex: 1, minWidth: 150 }} />
            <select value={filter} onChange={(e) => setFilter(e.target.value as 'all' | 'on' | 'off')} style={inputStyle}>
              <option value="all">All ({items.length})</option>
              <option value="on">{onLabel} ({enabledCount})</option>
              <option value="off">{offLabel} ({items.length - enabledCount})</option>
            </select>
            {tab.onSetMany && (
              <div style={{ display: 'inline-flex', gap: 6, flexShrink: 0 }}>
                <button className="secondary" onClick={() => tab.onSetMany!(filtered.map((m) => m.id), true)} disabled={busy} style={{ padding: '6px 10px', fontSize: 12 }}>Select all</button>
                <button className="secondary" onClick={() => tab.onSetMany!(filtered.map((m) => m.id), false)} disabled={busy} style={{ padding: '6px 10px', fontSize: 12 }}>Deselect all</button>
              </div>
            )}
            <div style={{ display: 'inline-flex', border: '1px solid var(--line)', borderRadius: 7, overflow: 'hidden', flexShrink: 0 }}>
              {(['grid', 'list'] as const).map((v) => (
                <button key={v} onClick={() => chooseView(v)} title={v === 'grid' ? 'Grid view' : 'List view'} style={{
                  padding: '7px 12px', fontSize: 12.5, cursor: 'pointer', border: 'none',
                  background: view === v ? 'var(--accent)' : 'transparent', color: view === v ? '#fff' : 'var(--muted)',
                }}>{v === 'grid' ? 'Grid' : 'List'}</button>
              ))}
            </div>
          </div>
          {shown.length === 0 ? (
            <div style={{ color: 'var(--muted)', fontSize: 12.5, padding: '8px 0 4px' }}>No mods match your search.</div>
          ) : view === 'grid' ? (
            // Every card is the same shape: fixed 4/3 thumbnail (contain-fit) + a 2-line title slot.
            <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', alignItems: 'start' }}>
              {shown.map((m) => (
                <div key={m.id} className="card" style={{ padding: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', borderColor: m.enabled ? 'var(--accent)' : 'var(--line)' }}>
                  <div style={{ position: 'relative', aspectRatio: '4 / 3', background: '#0e0e12', flexShrink: 0, overflow: 'hidden' }}><ModThumb preview={m.preview} poster={m.poster} /></div>
                  <div style={{ padding: '8px 10px 10px', display: 'flex', flexDirection: 'column', gap: 7 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 600, lineHeight: 1.3, height: '2.6em', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{m.title}</div>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: cardBusy(m) ? 'wait' : 'pointer' }}>
                      <span style={{ flex: 1, minWidth: 0, color: 'var(--muted)', fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.author ? `by ${m.author}` : ''}</span>
                      <input type="checkbox" checked={m.enabled} disabled={cardBusy(m)} onChange={() => tab.onToggle(m.id)} style={{ width: 17, height: 17, accentColor: 'var(--accent)', flexShrink: 0 }} />
                    </label>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {shown.map((m) => (
                <label key={m.id} className="card" style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '7px 10px', borderColor: m.enabled ? 'var(--accent)' : 'var(--line)', cursor: cardBusy(m) ? 'wait' : 'pointer' }}>
                  <div style={{ position: 'relative', width: 54, height: 32, flexShrink: 0, borderRadius: 4, overflow: 'hidden', background: '#0e0e12' }}><ModThumb preview={m.preview} poster={m.poster} /></div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.title}</div>
                    {m.author && <div style={{ color: 'var(--muted)', fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>by {m.author}</div>}
                  </div>
                  <input type="checkbox" checked={m.enabled} disabled={cardBusy(m)} onChange={() => tab.onToggle(m.id)} style={{ width: 17, height: 17, accentColor: 'var(--accent)', flexShrink: 0 }} />
                </label>
              ))}
            </div>
          )}
          {pages > 1 && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 14, marginTop: 13 }}>
              <button className="secondary" onClick={() => setPage(p - 1)} disabled={p === 0} style={{ padding: '5px 12px', fontSize: 12.5 }}>‹ Prev</button>
              <span style={{ color: 'var(--muted)', fontSize: 12 }}>Page {p + 1} of {pages}</span>
              <button className="secondary" onClick={() => setPage(p + 1)} disabled={p >= pages - 1} style={{ padding: '5px 12px', fontSize: 12.5 }}>Next ›</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
