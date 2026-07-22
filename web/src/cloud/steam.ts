// Steam sign-in client for the modder-hosting flow. The Worker (/steam/*) does the OpenID
// verification and issues a short-lived HMAC-signed token carrying the modder's SteamID64; here
// we just stash it, read the SteamID out of it for display, and call the mods/permission endpoints
// with it as a Bearer. All ownership checks happen server-side - the token is not trusted here.
import { useState, useEffect, useCallback } from 'react';
import { CLOUD_API } from './config';

const TOKEN_KEY = 'pz-steam-token';

export interface SteamMod { id: string; title: string; preview: string | null; size: number; }
export interface ModPermission { publishedfileid: string; title: string | null; status: 'allowed' | 'revoked'; consented_at: string; }

// Read the SteamID from the token payload (display only; the server re-verifies the signature).
function decodeSteamId(token: string | null): string | null {
  if (!token) return null;
  try {
    const body = token.split('.')[0];
    const p = JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/'))) as { steamid?: string; exp?: number };
    return p.steamid && p.exp && Date.now() < p.exp ? String(p.steamid) : null;
  } catch { return null; }
}

export interface SteamState {
  configured: boolean;
  token: string | null;
  steamid: string | null;
  justArrived: boolean; // token was picked up from the sign-in redirect this load
  error: string | null;
  signIn: () => void;
  signOut: () => void;
}

export function useSteam(): SteamState {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_KEY));
  const [error, setError] = useState<string | null>(null);
  const [justArrived, setJustArrived] = useState(false);

  // Pick up the token (or error) Steam sign-in left in the URL fragment, then scrub the URL so the
  // token never lingers in the address bar / history.
  useEffect(() => {
    const hash = window.location.hash;
    const clean = () => history.replaceState(null, '', window.location.pathname + window.location.search);
    const m = /(?:^|[#&])steam=([^&]+)/.exec(hash);
    if (m) {
      const t = decodeURIComponent(m[1]);
      localStorage.setItem(TOKEN_KEY, t); setToken(t); setError(null); setJustArrived(true); clean();
    } else if (/(?:^|[#&])steam_error=/.test(hash)) {
      setError('Steam sign-in failed. Please try again.'); clean();
    }
  }, []);

  // Drop a client-side-expired token (the server enforces this too).
  const steamid = decodeSteamId(token);
  useEffect(() => { if (token && !steamid) { localStorage.removeItem(TOKEN_KEY); setToken(null); } }, [token, steamid]);

  const signIn = useCallback(() => {
    if (!CLOUD_API) { setError('Online features are not configured.'); return; }
    window.location.href = `${CLOUD_API}/steam/login?return=${encodeURIComponent(window.location.origin)}`;
  }, []);
  const signOut = useCallback(() => { localStorage.removeItem(TOKEN_KEY); setToken(null); }, []);

  return { configured: !!CLOUD_API, token, steamid, justArrived, error, signIn, signOut };
}

async function api<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  if (!CLOUD_API) throw new Error('Online features are not configured.');
  const res = await fetch(`${CLOUD_API}${path}`, { ...init, headers: { ...(init?.headers || {}), Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    let msg = res.status === 401 ? 'Your Steam session expired. Sign in again.' : `Request failed (${res.status}).`;
    try { const j = await res.json(); if (j?.error) msg = j.error; } catch { /* not json */ }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

export const fetchSteamMods = (token: string) => api<{ steamid: string; mods: SteamMod[] }>('/steam/mods', token);
export const fetchModPermissions = (token: string) => api<{ permissions: ModPermission[] }>('/steam/permissions', token);
export const setModPermission = (token: string, id: string, allow: boolean) =>
  api<{ ok: boolean; id: string; status: 'allowed' | 'revoked' }>('/steam/permission', token, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, allow }),
  });
