// "Mods" top-level view: a modder signs in with Steam, sees the Workshop mods their account
// published (ownership is inherent - GetUserFiles only returns their own items), and toggles
// which ones may have their assets hosted so players can use them with no local install.
import { useEffect, useState, useCallback } from 'react';
import { type SteamState, fetchSteamMods, fetchModPermissions, setModPermission, type SteamMod } from './cloud/steam';

const CONTACT_EMAIL = 'alexredchili@gmail.com';
const kb = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export function ModderDashboard({ steam }: { steam: SteamState }) {
  const token = steam.token;
  const [mods, setMods] = useState<SteamMod[] | null>(null);
  const [perm, setPerm] = useState<Record<string, 'allowed' | 'revoked'>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true); setError(null);
    try {
      const [m, p] = await Promise.all([fetchSteamMods(token), fetchModPermissions(token)]);
      setMods(m.mods);
      const map: Record<string, 'allowed' | 'revoked'> = {};
      for (const row of p.permissions) map[row.publishedfileid] = row.status;
      setPerm(map);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, [token]);

  useEffect(() => { if (token) load(); else { setMods(null); setPerm({}); } }, [token, load]);

  const toggle = useCallback(async (id: string, allow: boolean) => {
    if (!token) return;
    const prev = perm[id];
    setBusy((b) => ({ ...b, [id]: true })); setError(null);
    setPerm((p) => ({ ...p, [id]: allow ? 'allowed' : 'revoked' })); // optimistic
    try { await setModPermission(token, id, allow); }
    catch (e) { setPerm((p) => ({ ...p, [id]: prev })); setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy((b) => ({ ...b, [id]: false })); }
  }, [token, perm]);

  const contact = (
    <>Questions, or want assets taken down? Email <a href={`mailto:${CONTACT_EMAIL}`} style={{ color: 'var(--accent)' }}>{CONTACT_EMAIL}</a>.</>
  );

  // --- signed out ---
  if (!token) {
    return (
      <section style={{ marginTop: 44, maxWidth: 600, marginInline: 'auto', textAlign: 'center' }}>
        <h2 style={{ fontSize: 25, margin: '0 0 12px' }}>Share your mod, no install required</h2>
        <p style={{ color: 'var(--muted)', fontSize: 14.5, lineHeight: 1.65, margin: '0 0 22px' }}>
          Let players use your Project Zomboid mod inside PZ Survivor Studio without installing it or the game. Sign in with Steam to see the mods your account published on the Workshop and choose which ones to allow. Steam only lists your own items, so your ownership is verified automatically - no IDs to paste.
        </p>
        <button onClick={steam.signIn} style={{ padding: '11px 20px', fontSize: 15, background: '#1b2838', border: '1px solid #2a475e', color: '#fff' }}>
          Sign in through Steam
        </button>
        {steam.error && <p style={{ color: '#ff8a8a', marginTop: 16 }}>{steam.error}</p>}
        <p style={{ color: 'var(--muted)', fontSize: 12.5, lineHeight: 1.6, marginTop: 22 }}>
          You choose exactly which mods to share and can revoke any of them at any time. By allowing a mod you confirm you have the right to have its assets hosted. {contact}
        </p>
      </section>
    );
  }

  // --- signed in ---
  const allowedCount = Object.values(perm).filter((s) => s === 'allowed').length;
  return (
    <div className="overview-enter" style={{ marginTop: 18, display: 'grid', gap: 14 }}>
      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 220 }}>
            <b style={{ fontSize: 14 }}>Host your mods</b>
            <div style={{ color: 'var(--muted)', fontSize: 12.5, marginTop: 3 }}>
              Signed in with Steam ({steam.steamid}) - {allowedCount} mod{allowedCount === 1 ? '' : 's'} allowed.
            </div>
          </div>
          <button className="secondary" onClick={load} disabled={loading} style={{ padding: '6px 12px', fontSize: 12.5 }}>{loading ? 'Refreshing…' : 'Refresh'}</button>
          <button className="secondary" onClick={steam.signOut} style={{ padding: '6px 12px', fontSize: 12.5 }}>Sign out</button>
        </div>
        <p style={{ color: 'var(--muted)', fontSize: 12.5, lineHeight: 1.6, margin: '12px 0 0' }}>
          Turn on hosting for a mod and its assets are downloaded from the Workshop and hosted, so anyone can use it in the studio with no install. Turn it off to revoke and have them removed. You confirm you have the right to allow hosting for each mod. {contact}
        </p>
        {error && <p style={{ color: '#ff8a8a', margin: '10px 0 0' }}>{error}</p>}
      </div>

      {loading && !mods && <div className="card" style={{ color: 'var(--muted)' }}><span className="spinner" /> Loading your Workshop mods…</div>}
      {mods && mods.length === 0 && (
        <div className="card" style={{ color: 'var(--muted)' }}>Steam returned no published PZ mods for this account. If your Workshop is set to private, make it public and Refresh.</div>
      )}
      {mods && mods.length > 0 && (
        <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))' }}>
          {mods.map((m) => {
            const allowed = perm[m.id] === 'allowed';
            return (
              <div key={m.id} className="card" style={{ padding: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', borderColor: allowed ? 'var(--accent)' : 'var(--line)' }}>
                <div style={{ aspectRatio: '16 / 9', background: '#0e0e12', overflow: 'hidden' }}>
                  {m.preview
                    ? <img src={m.preview} alt="" loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                    : <div style={{ width: '100%', height: '100%', display: 'grid', placeItems: 'center', color: '#3a3a44' }}>◈</div>}
                </div>
                <div style={{ padding: '10px 12px 12px', display: 'flex', flexDirection: 'column', gap: 8, flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.3, flex: 1 }}>{m.title || `Workshop item ${m.id}`}</div>
                  <div style={{ color: 'var(--muted)', fontSize: 11.5 }}>{kb(m.size)} · <a href={`https://steamcommunity.com/sharedfiles/filedetails/?id=${m.id}`} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--muted)' }}>Workshop ↗</a></div>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: busy[m.id] ? 'wait' : 'pointer', fontSize: 12.5, marginTop: 2 }}>
                    <input type="checkbox" checked={allowed} disabled={!!busy[m.id]} onChange={(e) => toggle(m.id, e.target.checked)} />
                    <span style={{ color: allowed ? 'var(--text)' : 'var(--muted)', fontWeight: allowed ? 600 : 400 }}>
                      {busy[m.id] ? 'Saving…' : allowed ? 'Hosting allowed' : 'Allow hosting'}
                    </span>
                  </label>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
