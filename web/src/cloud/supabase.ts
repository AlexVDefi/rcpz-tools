import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config';

// Lazily-created singleton Supabase client, or null when the cloud feature is not configured.
let client: SupabaseClient | null = null;
let built = false;

export function getSupabase(): SupabaseClient | null {
  if (built) return client;
  built = true;
  if (SUPABASE_URL && SUPABASE_ANON_KEY) {
    client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'pz-cloud-auth' },
    });
  }
  return client;
}
