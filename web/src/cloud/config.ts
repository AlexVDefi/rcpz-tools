// Cloud (online sharing) configuration, read from Vite env at BUILD time. When any of these is
// unset the entire online feature stays OFF: no Supabase client is created, no auth UI renders,
// and the app is 100% local. The CSP connect-src is only widened (to these exact origins) when
// the feature is configured - a bug still cannot reach an arbitrary host.
export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL?.replace(/\/$/, '');
export const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
// Base URL of the Cloudflare Worker that handles uploads + serves files (e.g. https://share.example.com)
export const CLOUD_API = import.meta.env.VITE_CLOUD_API?.replace(/\/$/, '');

export const cloudConfigured = !!(SUPABASE_URL && SUPABASE_ANON_KEY && CLOUD_API);

// Per-user storage cap, mirrored on the Worker (which enforces it authoritatively). Client-side
// this drives the usage bar; the server value wins if they ever differ.
export const QUOTA_BYTES = 100 * 1024 * 1024;

export const fmtBytes = (n: number) => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};
