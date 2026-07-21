import { useState } from 'react';
import type { AuthState } from './auth';

// Email + password sign-in / sign-up dialog for the optional online sharing feature, plus a
// "forgot password" mode that emails a reset link.
export function AuthModal({ auth, onClose }: { auth: AuthState; onClose: () => void }) {
  const [mode, setMode] = useState<'in' | 'up' | 'reset'>('in');
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [info, setInfo] = useState('');

  const swap = (m: 'in' | 'up' | 'reset') => { setMode(m); setErr(''); setInfo(''); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setErr(''); setInfo(''); setBusy(true);
    try {
      if (mode === 'in') {
        const { error } = await auth.signIn(email.trim(), pw);
        if (error) setErr(error); else onClose();
      } else if (mode === 'up') {
        const { error, needsConfirm } = await auth.signUp(email.trim(), pw);
        if (error) setErr(error);
        else if (needsConfirm) setInfo('Account created. Check your email for a confirmation link, then sign in.');
        else onClose();
      } else {
        const { error } = await auth.resetPassword(email.trim());
        if (error) setErr(error);
        else setInfo('If an account exists for that email, a password-reset link is on its way. Open it to set a new password.');
      }
    } catch (e2) { setErr(e2 instanceof Error ? e2.message : String(e2)); }
    finally { setBusy(false); }
  };

  const input = { background: '#14141a', color: 'var(--text)', border: '1px solid var(--line)', borderRadius: 6, padding: '9px 11px', fontSize: 13, width: '100%' } as const;
  const title = mode === 'in' ? 'Sign in' : mode === 'up' ? 'Create an account' : 'Reset your password';
  const cta = busy ? 'Please wait…' : mode === 'in' ? 'Sign in' : mode === 'up' ? 'Create account' : 'Send reset link';

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#000000aa', zIndex: 400, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onClose}>
      <form onClick={(e) => e.stopPropagation()} onSubmit={submit}
        style={{ width: 380, maxWidth: '92vw', background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 12, padding: 20, boxShadow: '0 24px 70px #000000aa' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
          <div style={{ fontSize: 16, fontWeight: 700 }}>{title}</div>
          <span role="button" onClick={onClose} title="close" style={{ cursor: 'pointer', color: 'var(--muted)', padding: '0 4px' }}>✕</span>
        </div>
        <div style={{ color: 'var(--muted)', fontSize: 12.5, marginBottom: 14 }}>
          {mode === 'reset' ? 'Enter your account email and we will send you a link to set a new password.' : 'Optional - only needed to upload and share renders online.'}
        </div>

        <label style={{ fontSize: 12, color: 'var(--muted)' }}>Email</label>
        <input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} style={{ ...input, margin: '4px 0 10px' }} />

        {mode !== 'reset' && (
          <>
            <label style={{ fontSize: 12, color: 'var(--muted)' }}>Password</label>
            <input type="password" required minLength={6} autoComplete={mode === 'in' ? 'current-password' : 'new-password'} value={pw} onChange={(e) => setPw(e.target.value)} style={{ ...input, margin: '4px 0 6px' }} />
          </>
        )}

        {mode === 'in' && (
          <div style={{ textAlign: 'right', marginTop: 4 }}>
            <a role="button" onClick={() => swap('reset')} style={{ cursor: 'pointer', fontSize: 12 }}>Forgot password?</a>
          </div>
        )}

        {err && <div style={{ color: '#ff8a8a', fontSize: 12.5, margin: '8px 0 0' }}>{err}</div>}
        {info && <div style={{ color: '#6fd08a', fontSize: 12.5, margin: '8px 0 0' }}>{info}</div>}

        <button type="submit" disabled={busy} style={{ width: '100%', padding: '10px', marginTop: 14, fontWeight: 600, opacity: busy ? 0.6 : 1 }}>
          {cta}
        </button>

        <div style={{ textAlign: 'center', marginTop: 12, fontSize: 12.5, color: 'var(--muted)' }}>
          {mode === 'in' ? (
            <>No account? <a role="button" onClick={() => swap('up')} style={{ cursor: 'pointer' }}>Create one</a></>
          ) : mode === 'up' ? (
            <>Already have one? <a role="button" onClick={() => swap('in')} style={{ cursor: 'pointer' }}>Sign in</a></>
          ) : (
            <>Remembered it? <a role="button" onClick={() => swap('in')} style={{ cursor: 'pointer' }}>Back to sign in</a></>
          )}
        </div>
      </form>
    </div>
  );
}
