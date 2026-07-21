import { useCallback, useEffect, useState } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { getSupabase } from './supabase';
import { cloudConfigured } from './config';

export interface AuthState {
  configured: boolean;         // cloud env is present
  ready: boolean;              // finished the initial session check
  user: User | null;
  session: Session | null;
  recovery: boolean;           // a password-reset link brought the user back; force a new password
  signIn: (email: string, password: string) => Promise<{ error?: string }>;
  signUp: (email: string, password: string) => Promise<{ error?: string; needsConfirm?: boolean }>;
  signOut: () => Promise<void>;
  resetPassword: (email: string) => Promise<{ error?: string }>;
  updatePassword: (password: string) => Promise<{ error?: string }>;
  clearRecovery: () => void;
}

// Email + password auth backed by Supabase. A no-op shell when the cloud feature is unconfigured.
export function useAuth(): AuthState {
  const sb = getSupabase();
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(!sb);
  const [recovery, setRecovery] = useState(false);

  useEffect(() => {
    if (!sb) return;
    let live = true;
    sb.auth.getSession().then(({ data }) => { if (live) { setSession(data.session); setReady(true); } });
    // detectSessionInUrl (see supabase.ts) turns a reset-email link into a PASSWORD_RECOVERY event
    // with a temporary session; we surface that so the app can force a "set a new password" step.
    const { data: sub } = sb.auth.onAuthStateChange((event, s) => {
      if (!live) return;
      setSession(s);
      if (event === 'PASSWORD_RECOVERY') setRecovery(true);
    });
    return () => { live = false; sub.subscription.unsubscribe(); };
  }, [sb]);

  const signIn = useCallback(async (email: string, password: string) => {
    if (!sb) return { error: 'Online sharing is not configured.' };
    const { error } = await sb.auth.signInWithPassword({ email, password });
    return { error: error?.message };
  }, [sb]);

  const signUp = useCallback(async (email: string, password: string) => {
    if (!sb) return { error: 'Online sharing is not configured.' };
    const { data, error } = await sb.auth.signUp({ email, password });
    if (error) return { error: error.message };
    // With email confirmation on, signUp returns a user but no session until they confirm.
    return { needsConfirm: !data.session };
  }, [sb]);

  const signOut = useCallback(async () => { await sb?.auth.signOut(); }, [sb]);

  // Send a password-reset email. The link returns the user to this app (origin must be in the
  // Supabase Auth "Redirect URLs" allowlist), where it fires PASSWORD_RECOVERY.
  const resetPassword = useCallback(async (email: string) => {
    if (!sb) return { error: 'Online sharing is not configured.' };
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin });
    return { error: error?.message };
  }, [sb]);

  // Set a new password for the current session (a signed-in user, or a recovery session).
  const updatePassword = useCallback(async (password: string) => {
    if (!sb) return { error: 'Online sharing is not configured.' };
    const { error } = await sb.auth.updateUser({ password });
    return { error: error?.message };
  }, [sb]);

  const clearRecovery = useCallback(() => setRecovery(false), []);

  return {
    configured: cloudConfigured, ready, user: session?.user ?? null, session, recovery,
    signIn, signUp, signOut, resetPassword, updatePassword, clearRecovery,
  };
}
