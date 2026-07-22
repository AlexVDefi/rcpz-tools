// "Modders" top-level view: a modder signs in with Steam, sees the Workshop mods their account
// published (ownership is inherent - GetUserFiles only returns their own items), and toggles
// which ones may have their assets hosted so players can use them with no local install. Uses the
// shared ModsPanel so it matches the studio's community / installed mod browsers.
import { useEffect, useState, useCallback } from 'react';
import { type SteamState, fetchSteamMods, fetchModPermissions, setModPermission, type SteamMod } from './cloud/steam';
import { ModsPanel, type ModTab } from './ModsBrowser';

const CONTACT_EMAIL = 'alexredchili@gmail.com';
const kb = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export function ModderDashboard({ steam }: { steam: SteamState }) {
  const token = steam.token;
  const [mods, setMods] = useState<SteamMod[] | null>(null);
  const [perm, setPerm] = useState<Record<string, 'allowed' | 'revoked'>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmMod, setConfirmMod] = useState<SteamMod | null>(null); // pending single allow, awaiting co-contributor confirmation
  const [confirmAll, setConfirmAll] = useState<string[] | null>(null); // pending bulk allow (Select all)

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

  // A card's checkbox: revoke immediately, but allowing opens the co-contributor confirmation first.
  const onToggle = useCallback((id: string) => {
    if (perm[id] === 'allowed') toggle(id, false);
    else { const m = mods?.find((x) => x.id === id); if (m) setConfirmMod(m); }
  }, [perm, toggle, mods]);
  // Select all / Deselect all over the filtered set: revoking is immediate, allowing confirms once.
  const onSetMany = useCallback((ids: string[], enable: boolean) => {
    if (!enable) { ids.forEach((id) => { if (perm[id] === 'allowed') toggle(id, false); }); return; }
    const toAllow = ids.filter((id) => perm[id] !== 'allowed');
    if (toAllow.length) setConfirmAll(toAllow);
  }, [perm, toggle]);

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
  const tab: ModTab = {
    key: 'mine',
    label: 'Your Workshop mods',
    onToggle,
    onSetMany,
    onLabel: 'Allowed',
    offLabel: 'Not allowed',
    items: (mods ?? []).map((m) => ({
      id: m.id,
      title: m.title || `Workshop item ${m.id}`,
      enabled: perm[m.id] === 'allowed',
      preview: m.preview,
      busy: !!busy[m.id],
      subtitle: <>{kb(m.size)} · <a href={`https://steamcommunity.com/sharedfiles/filedetails/?id=${m.id}`} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} style={{ color: 'var(--muted)' }}>Workshop ↗</a></>,
    })),
    note: 'Allow a mod and its assets are downloaded from the Workshop and hosted, so anyone can use it in the studio with no install. Turn it off any time to revoke and have them removed.',
  };

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
          You confirm you have the right to allow hosting for each mod. {contact}
        </p>
        {error && <p style={{ color: '#ff8a8a', margin: '10px 0 0' }}>{error}</p>}
      </div>

      {loading && !mods && <div className="card" style={{ color: 'var(--muted)' }}><span className="spinner" /> Loading your Workshop mods…</div>}
      {mods && mods.length === 0 && (
        <div className="card" style={{ color: 'var(--muted)' }}>Steam returned no published PZ mods for this account. If your Workshop is set to private, make it public and Refresh.</div>
      )}
      {mods && mods.length > 0 && (
        <div className="card"><ModsPanel tabs={[tab]} busy={loading} divided={false} /></div>
      )}

      {confirmMod && (
        <div onClick={() => setConfirmMod(null)} style={{ position: 'fixed', inset: 0, background: '#000a', display: 'grid', placeItems: 'center', zIndex: 100, padding: 20 }}>
          <div className="card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 440, width: '100%' }}>
            <b style={{ fontSize: 15 }}>Allow hosting for this mod?</b>
            <p style={{ color: 'var(--muted)', fontSize: 13.5, lineHeight: 1.6, margin: '10px 0 6px' }}>
              You're about to let <b style={{ color: 'var(--text)' }}>{confirmMod.title || `Workshop item ${confirmMod.id}`}</b> be hosted so anyone can use it in the studio with no install.
            </p>
            <p style={{ color: 'var(--muted)', fontSize: 13.5, lineHeight: 1.6, margin: '0 0 18px' }}>
              If <b style={{ color: 'var(--text)' }}>anyone else contributed</b> to this mod, make sure you have <b style={{ color: 'var(--text)' }}>their permission</b> first. By continuing you confirm you have the right to host all of its assets.
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="secondary" onClick={() => setConfirmMod(null)} style={{ padding: '8px 14px' }}>Cancel</button>
              <button onClick={() => { const m = confirmMod; setConfirmMod(null); toggle(m.id, true); }} style={{ padding: '8px 14px' }}>I have permission, allow</button>
            </div>
          </div>
        </div>
      )}

      {confirmAll && (
        <div onClick={() => setConfirmAll(null)} style={{ position: 'fixed', inset: 0, background: '#000a', display: 'grid', placeItems: 'center', zIndex: 100, padding: 20 }}>
          <div className="card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 440, width: '100%' }}>
            <b style={{ fontSize: 15 }}>Allow hosting for {confirmAll.length} mod{confirmAll.length === 1 ? '' : 's'}?</b>
            <p style={{ color: 'var(--muted)', fontSize: 13.5, lineHeight: 1.6, margin: '10px 0 6px' }}>
              Their assets will be downloaded from the Workshop and hosted so anyone can use them in the studio with no install.
            </p>
            <p style={{ color: 'var(--muted)', fontSize: 13.5, lineHeight: 1.6, margin: '0 0 18px' }}>
              If <b style={{ color: 'var(--text)' }}>anyone else contributed</b> to any of them, make sure you have <b style={{ color: 'var(--text)' }}>their permission</b> first. By continuing you confirm you have the right to host all of their assets.
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="secondary" onClick={() => setConfirmAll(null)} style={{ padding: '8px 14px' }}>Cancel</button>
              <button onClick={() => { const ids = confirmAll; setConfirmAll(null); ids.forEach((id) => toggle(id, true)); }} style={{ padding: '8px 14px' }}>I have permission, allow all</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
