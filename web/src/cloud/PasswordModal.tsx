import { useState } from 'react';
import type { AuthState } from './auth';

// Set-a-new-password dialog, in two modes:
//   'change'   - a signed-in user changing their password. Verifies the current password first
//                (re-authenticate), so an unattended open session can't be used to take over.
//   'recovery' - the user arrived from a password-reset email link (a recovery session). No
//                current password to check; they just set a new one.
export function PasswordModal({ auth, mode, onClose }: {
  auth: AuthState;
  mode: 'change' | 'recovery';
  onClose: () => void;
}) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState(false);
  const email = auth.user?.email || '';

  const close = () => { if (mode === 'recovery') auth.clearRecovery(); onClose(); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setErr('');
    if (next.length < 6) { setErr('New password must be at least 6 characters.'); return; }
    if (next !== confirm) { setErr('The new passwords do not match.'); return; }
    setBusy(true);
    try {
      // change mode: confirm the current password by re-authenticating before allowing the change
      if (mode === 'change') {
        const { error } = await auth.signIn(email, current);
        if (error) { setErr('Current password is incorrect.'); setBusy(false); return; }
      }
      const { error } = await auth.updatePassword(next);
      if (error) { setErr(error); setBusy(false); return; }
      // Show the success state. In recovery mode we DON'T clear the recovery flag here - that flag
      // is what keeps this modal mounted, so clearing it now would unmount before "Done". It clears
      // in close() instead.
      setDone(true);
    } catch (e2) { setErr(e2 instanceof Error ? e2.message : String(e2)); setBusy(false); }
  };

  const input = { background: '#14141a', color: 'var(--text)', border: '1px solid var(--line)', borderRadius: 6, padding: '9px 11px', fontSize: 13, width: '100%' } as const;
  const heading = mode === 'recovery' ? 'Set a new password' : 'Change password';

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#000000bb', zIndex: 620, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }} onClick={busy ? undefined : close}>
      <form onClick={(e) => e.stopPropagation()} onSubmit={submit}
        style={{ width: 400, maxWidth: '94vw', background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 12, padding: 20, boxShadow: '0 24px 70px #000000aa' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
          <div style={{ fontSize: 16, fontWeight: 700 }}>{heading}</div>
          <span role="button" onClick={busy ? undefined : close} title="close" style={{ cursor: busy ? 'default' : 'pointer', color: 'var(--muted)', padding: '0 4px', opacity: busy ? 0.4 : 1 }}>✕</span>
        </div>

        {done ? (
          <>
            <div style={{ color: '#6fd08a', fontSize: 13, lineHeight: 1.6, margin: '4px 0 14px' }}>
              Your password has been updated{mode === 'recovery' ? " and you're signed in" : ''}. Use the new password next time you sign in.
            </div>
            <button type="button" onClick={close} style={{ width: '100%', padding: '10px', fontWeight: 600 }}>Done</button>
          </>
        ) : (
          <>
            <div style={{ color: 'var(--muted)', fontSize: 12.5, marginBottom: 14 }}>
              {mode === 'recovery'
                ? 'Choose a new password for your account. You are setting this from your reset link.'
                : `Update the password for ${email || 'your account'}.`}
            </div>

            {mode === 'change' && (
              <>
                <label style={{ fontSize: 12, color: 'var(--muted)' }}>Current password</label>
                <input type="password" required autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} style={{ ...input, margin: '4px 0 10px' }} />
              </>
            )}

            <label style={{ fontSize: 12, color: 'var(--muted)' }}>New password</label>
            <input type="password" required minLength={6} autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} style={{ ...input, margin: '4px 0 10px' }} />

            <label style={{ fontSize: 12, color: 'var(--muted)' }}>Confirm new password</label>
            <input type="password" required minLength={6} autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} style={{ ...input, margin: '4px 0 6px' }} />

            {err && <div style={{ color: '#ff8a8a', fontSize: 12.5, margin: '8px 0 0' }}>{err}</div>}

            <button type="submit" disabled={busy} style={{ width: '100%', padding: '10px', marginTop: 14, fontWeight: 600, opacity: busy ? 0.6 : 1 }}>
              {busy ? 'Updating…' : mode === 'recovery' ? 'Set password' : 'Change password'}
            </button>
          </>
        )}
      </form>
    </div>
  );
}
