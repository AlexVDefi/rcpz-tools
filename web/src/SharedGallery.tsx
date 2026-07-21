import { useCallback, useEffect, useState } from 'react';
import type { CloudUploads, UploadRow } from './cloud/uploads';
import type { ShareMeta } from './cloud/share-meta';
import { fmtBytes } from './cloud/config';
import logoUrl from './assets/logo.png';

const isVideo = (r: UploadRow) => r.kind === 'mp4' || (r.content_type?.startsWith('video/') ?? false);

// The "Shared" tab: a scrollable grid of thumbnails of everything the signed-in user has shared,
// so they can quickly find a past render and grab its link again. Clicking one opens the custom
// share viewer (watermark + details).
export function SharedGallery({ uploads }: { uploads: CloudUploads }) {
  const { rows, used, limit, loading, refresh, remove } = uploads;
  const [openIdx, setOpenIdx] = useState<number | null>(null);

  // keep the open viewer pointed at a valid row as the list changes (e.g. after a delete)
  useEffect(() => {
    if (openIdx === null) return;
    if (!rows.length) setOpenIdx(null);
    else if (openIdx >= rows.length) setOpenIdx(rows.length - 1);
  }, [rows.length, openIdx]);

  const removeRow = useCallback(async (key: string) => { await remove(key); }, [remove]);

  return (
    <div className="overview-enter" style={{ marginTop: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 19, fontWeight: 700, lineHeight: 1.1 }}>Shared</div>
          <div style={{ color: 'var(--muted)', fontSize: 12.5, marginTop: 2 }}>
            Everything you've shared online. Open one to grab its link again or see what's in it.
          </div>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ color: 'var(--muted)', fontSize: 12 }}>
            <b style={{ color: 'var(--text)' }}>{fmtBytes(used)}</b> of {fmtBytes(limit)} used
          </span>
          <button className="secondary" onClick={() => refresh()} disabled={loading} style={{ padding: '6px 12px', fontSize: 12.5 }}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      {loading && !rows.length ? (
        <div className="card" style={{ textAlign: 'center', color: 'var(--muted)' }}><span className="spinner" /> Loading your shares…</div>
      ) : !rows.length ? (
        <div className="card" style={{ textAlign: 'center', padding: '48px 20px' }}>
          <div style={{ fontSize: 30, marginBottom: 8, color: '#3a3a44' }}>◈</div>
          <strong style={{ fontSize: 15 }}>You haven't shared anything yet</strong>
          <p style={{ color: 'var(--muted)', margin: '8px auto 0', maxWidth: 380, lineHeight: 1.6 }}>
            Open the Character viewer, dress a survivor, then use <b>Share online</b> in the Scene tab. Your shared
            renders show up here.
          </p>
        </div>
      ) : (
        <div className="share-grid">
          {rows.map((r, i) => (
            <button key={r.id} className="share-card" onClick={() => setOpenIdx(i)} title="Open">
              {isVideo(r)
                ? <video src={r.url} muted playsInline preload="metadata" />
                : <img src={r.url} alt="" loading="lazy" />}
              <span className="share-kind">{(r.kind || 'file').toUpperCase()}</span>
              {isVideo(r) && <span className="share-play">▶</span>}
              <span className="share-open">Open</span>
            </button>
          ))}
        </div>
      )}

      {openIdx !== null && rows[openIdx] && (
        <ShareViewer
          rows={rows}
          index={openIdx}
          onIndex={setOpenIdx}
          onClose={() => setOpenIdx(null)}
          onRemove={removeRow}
        />
      )}
    </div>
  );
}

// Custom full-screen viewer for a shared render. Shows the media large with a "PZ Survivor Studio"
// watermark in the bottom-right by default, plus a Details button that reveals what's equipped and
// which mods it comes from. Also the practical actions: copy link, open, delete, and prev/next.
function ShareViewer({ rows, index, onIndex, onClose, onRemove }: {
  rows: UploadRow[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
  onRemove: (key: string) => Promise<void>;
}) {
  const row = rows[index];
  const [details, setDetails] = useState(false);
  const [watermark, setWatermark] = useState(true);
  const [copied, setCopied] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);

  const go = useCallback((dir: -1 | 1) => {
    const n = index + dir;
    if (n >= 0 && n < rows.length) { onIndex(n); setConfirmDel(false); setCopied(false); }
  }, [index, rows.length, onIndex]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft') go(-1);
      else if (e.key === 'ArrowRight') go(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, onClose]);

  const copy = async () => { try { await navigator.clipboard.writeText(row.url); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ } };
  const del = async () => {
    if (deleting) return;
    setDeleting(true);
    try { await onRemove(row.key); } finally { setDeleting(false); setConfirmDel(false); }
  };

  return (
    <div className="viewer-overlay" onClick={onClose}>
      <div className="viewer-body" onClick={(e) => e.stopPropagation()}>
        {/* toolbar */}
        <div className="viewer-bar">
          <span className="viewer-kind">{(row.kind || 'file').toUpperCase()}</span>
          <span className="viewer-meta">{new Date(row.created_at).toLocaleDateString()} · {fmtBytes(row.size)}</span>
          <span style={{ flex: 1 }} />
          <button className="secondary" onClick={() => setWatermark((v) => !v)} title="Toggle the watermark"
            style={{ padding: '6px 12px', fontSize: 12.5, background: watermark ? 'var(--accent)' : 'var(--panel)', color: watermark ? '#fff' : 'var(--text)' }}>Watermark</button>
          <button className="secondary" onClick={() => setDetails((v) => !v)} title="Show what's equipped and the mods used"
            style={{ padding: '6px 12px', fontSize: 12.5, background: details ? 'var(--accent)' : 'var(--panel)', color: details ? '#fff' : 'var(--text)' }}>Details</button>
          <button className="secondary" onClick={copy} style={{ padding: '6px 12px', fontSize: 12.5 }}>{copied ? 'Copied' : 'Copy link'}</button>
          <a className="secondary viewer-link" href={row.url} target="_blank" rel="noopener noreferrer">Open</a>
          <button className="secondary" onClick={onClose} title="Close (Esc)" style={{ padding: '6px 11px', fontSize: 14 }}>✕</button>
        </div>

        {/* stage: media + optional watermark + side details */}
        <div className="viewer-stage">
          {rows.length > 1 && <button className="viewer-nav viewer-prev" onClick={() => go(-1)} disabled={index === 0} title="Previous (←)">‹</button>}
          <div className="viewer-media">
            {isVideo(row)
              ? <video key={row.id} src={row.url} controls autoPlay loop playsInline />
              : <img key={row.id} src={row.url} alt="" />}
            {watermark && (
              <div className="viewer-watermark">
                <img src={logoUrl} alt="" width={16} height={16} />
                <span>PZ Survivor Studio</span>
              </div>
            )}
          </div>
          {details && <ShareDetails meta={row.meta} />}
          {rows.length > 1 && <button className="viewer-nav viewer-next" onClick={() => go(1)} disabled={index === rows.length - 1} title="Next (→)">›</button>}
        </div>

        {/* footer: delete + count */}
        <div className="viewer-foot">
          {confirmDel ? (
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 12.5, color: '#ffb454' }}>Delete this share permanently?</span>
              <button className="secondary" onClick={del} disabled={deleting} style={{ padding: '5px 12px', fontSize: 12.5, color: '#ff6b6b' }}>{deleting ? 'Deleting…' : 'Delete'}</button>
              <button className="secondary" onClick={() => setConfirmDel(false)} disabled={deleting} style={{ padding: '5px 12px', fontSize: 12.5 }}>Cancel</button>
            </span>
          ) : (
            <button className="secondary" onClick={() => setConfirmDel(true)} style={{ padding: '5px 12px', fontSize: 12.5, color: '#ff6b6b' }}>Delete share</button>
          )}
          <span style={{ marginLeft: 'auto', color: 'var(--muted)', fontSize: 12 }}>{index + 1} of {rows.length}</span>
        </div>
      </div>
    </div>
  );
}

// The details panel: equipped clothing and held items, each tagged with the mod it comes from (or
// "Vanilla"), and a summary of the mods used. Older shares have no captured details.
function ShareDetails({ meta }: { meta: ShareMeta | null }) {
  if (!meta || (!meta.clothing.length && !meta.held.length)) {
    return (
      <div className="viewer-details">
        <div className="viewer-details-title">Details</div>
        <p style={{ color: 'var(--muted)', fontSize: 12.5, lineHeight: 1.6, margin: 0 }}>
          {meta ? 'Nothing was equipped in this render.' : "Details weren't captured for this share. Newer shares record what's equipped and the mods they use."}
        </p>
      </div>
    );
  }
  const modTag = (mod: string | null) => (
    <span className="viewer-modtag" style={mod ? undefined : { color: 'var(--muted)' }}>{mod || 'Vanilla'}</span>
  );
  return (
    <div className="viewer-details">
      <div className="viewer-details-title">Details</div>
      {meta.gender && <div className="viewer-details-sub">{meta.gender === 'female' ? 'Female' : 'Male'} survivor</div>}

      {meta.held.length > 0 && (
        <>
          <div className="viewer-details-head">Held ({meta.held.length})</div>
          {meta.held.map((h, i) => (
            <div key={'h' + i} className="viewer-item">
              <span className="viewer-item-name" title={h.name}>{h.name}</span>
              <span className="viewer-hand" title={`held in ${h.hand} hand`}>{h.hand === 'left' ? 'L' : 'R'}</span>
              {modTag(h.mod)}
            </div>
          ))}
        </>
      )}

      {meta.clothing.length > 0 && (
        <>
          <div className="viewer-details-head">Clothing ({meta.clothing.length})</div>
          {meta.clothing.map((c, i) => (
            <div key={'c' + i} className="viewer-item">
              <span className="viewer-item-name" title={c.name}>{c.name}</span>
              {modTag(c.mod)}
            </div>
          ))}
        </>
      )}

      {meta.mods.length > 0 && (
        <>
          <div className="viewer-details-head">Mods used ({meta.mods.length})</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
            {meta.mods.map((m) => <span key={m} className="viewer-modtag" title={m}>{m}</span>)}
          </div>
        </>
      )}
    </div>
  );
}
