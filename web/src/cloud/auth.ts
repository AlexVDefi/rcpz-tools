import { useCallback, useEffect, useState } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { getSupabase } from './supabase';
import { cloudConfigured } from './config';

export interface AuthState {
  configured: boolean;         // cloud env is present
  ready: boolean;              // finished the initial session check
  user: User | null;
  session: Session | null;
  signIn: (email: string, password: string) => Promise<{ error?: string }>;
  signUp: (email: string, password: string) => Promise<{ error?: string; needsConfirm?: boolean }>;
  signOut: () => Promise<void>;
}

// Email + password auth backed by Supabase. A no-op shell when the cloud feature is unconfigured.
export function useAuth(): AuthState {
  const sb = getSupabase();
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(!sb);

  useEffect(() => {
    if (!sb) return;
    let live = true;
    sb.auth.getSession().then(({ data }) => { if (live) { setSession(data.session); setReady(true); } });
    const { data: sub } = sb.auth.onAuthStateChange((_e, s) => { if (live) setSession(s); });
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

  return { configured: cloudConfigured, ready, user: session?.user ?? null, session, signIn, signUp, signOut };
}
