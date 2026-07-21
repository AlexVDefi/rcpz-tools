import { useState } from 'react';
import type { AuthState } from './auth';
import type { CloudUploads } from './uploads';
import { deleteAccount } from './api';
import { fmtBytes } from './config';

// Permanently-delete-account dialog. States plainly that this also deletes every shared item, and
// requires the user to type DELETE so it can't happen by a stray click. On success it signs the
// user out and hands control back to the app.
export function DeleteAccountModal({ auth, uploads, onClose, onDeleted }: {
  auth: AuthState;
  uploads: CloudUploads;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const email = auth.user?.email || 'your account';
  const shareCount = uploads.rows.length;
  const armed = confirm.trim().toUpperCase() === 'DELETE';

  const doDelete = async () => {
    if (!armed || busy || !auth.session) return;
    setErr(''); setBusy(true);
    try {
      await deleteAccount(auth.session.access_token);
      await auth.signOut();
      onDeleted();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#000000bb', zIndex: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }} onClick={busy ? undefined : onClose}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ width: 440, maxWidth: '94vw', background: 'var(--panel)', border: '1px solid #5a3a3a', borderRadius: 12, padding: 20, boxShadow: '0 24px 70px #000000aa' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#ff8a8a' }}>Delete your account</div>
          <span role="button" onClick={busy ? undefined : onClose} title="close" style={{ cursor: busy ? 'default' : 'pointer', color: 'var(--muted)', padding: '0 4px', opacity: busy ? 0.4 : 1 }}>✕</span>
        </div>

        <p style={{ color: 'var(--text)', fontSize: 13, lineHeight: 1.6, margin: '4px 0 10px' }}>
          This permanently deletes <b>{email}</b> and <b>all of your shared items</b> - every render you've uploaded
          and every share link. Anyone you gave a link to will no longer be able to open it. <b>This cannot be undone.</b>
        </p>

        <div style={{ background: '#2c2226', border: '1px solid #5a3a3a', borderRadius: 8, padding: '10px 12px', fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.6, marginBottom: 12 }}>
          You currently have <b style={{ color: 'var(--text)' }}>{shareCount}</b> shared item{shareCount === 1 ? '' : 's'} ({fmtBytes(uploads.used)}). All of it will be deleted.
          <br />Nothing on your own computer (your game, saves, mods, or local exports) is touched.
        </div>

        <label style={{ fontSize: 12, color: 'var(--muted)' }}>Type <b style={{ color: 'var(--text)' }}>DELETE</b> to confirm</label>
        <input value={confirm} onChange={(e) => setConfirm(e.target.value)} autoFocus disabled={busy} placeholder="DELETE"
          style={{ width: '100%', margin: '5px 0 4px', background: '#14141a', color: 'var(--text)', border: '1px solid var(--line)', borderRadius: 6, padding: '9px 11px', fontSize: 13 }} />

        {err && <div style={{ color: '#ff8a8a', fontSize: 12.5, margin: '6px 0 0' }}>{err}</div>}

        <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          <button className="secondary" onClick={onClose} disabled={busy} style={{ flex: 1, padding: '10px' }}>Cancel</button>
          <button onClick={doDelete} disabled={!armed || busy}
            style={{ flex: 1, padding: '10px', fontWeight: 600, background: armed ? '#b23b3b' : 'var(--panel)', color: armed ? '#fff' : 'var(--muted)', border: armed ? '0' : '1px solid var(--line)', opacity: busy ? 0.6 : 1 }}>
            {busy ? 'Deleting…' : 'Delete account permanently'}
          </button>
        </div>
      </div>
    </div>
  );
}
