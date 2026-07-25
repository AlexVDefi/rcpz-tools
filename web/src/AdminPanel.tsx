// Owner-only admin panel: every registered user with their cloud-storage usage, and every modder who
// authed with Steam plus the mods they've allowed. This is a convenience view - the data only loads
// because the Worker verified the caller's email against its ADMIN_EMAIL secret (a non-admin gets 403).
import { useEffect, useState } from 'react';
import { fetchAdminOverview, type AdminOverview, type AdminModderMod } from './cloud/api';

const humanBytes = (n: number): string => {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
};
const shortDate = (s: string | null): string => {
  if (!s) return '-';
  const d = new Date(s);
  return isNaN(d.getTime()) ? '-' : d.toISOString().slice(0, 10);
};

const cardStyle: React.CSSProperties = { background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 8, padding: '10px 12px' };
const th: React.CSSProperties = { textAlign: 'left', fontSize: 11, textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--muted)', fontWeight: 600, padding: '6px 8px', position: 'sticky', top: 0, background: '#1b1b21' };
const td: React.CSSProperties = { padding: '6px 8px', fontSize: 12.5, borderTop: '1px solid var(--line)', whiteSpace: 'nowrap' };

export function AdminPanel({ token, onClose }: { token: string; onClose: () => void }) {
  const [data, setData] = useState<AdminOverview | null>(null);
  const [err, setErr] = useState('');
  const [tab, setTab] = useState<'users' | 'modders'>('users');

  useEffect(() => {
    let live = true;
    setErr(''); setData(null);
    fetchAdminOverview(token)
      .then((d) => { if (live) setData(d); })
      .catch((e) => { if (live) setErr(e instanceof Error ? e.message : 'Failed to load'); });
    return () => { live = false; };
  }, [token]);

  const statusColor = (m: AdminModderMod): string =>
    m.status !== 'allowed' ? '#c96b6b' : m.host_status === 'hosted' ? '#6ea06e' : '#c9a24b';

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 600, background: 'rgba(8,9,13,.82)', backdropFilter: 'blur(6px)', display: 'grid', placeItems: 'center', padding: 20 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 960, maxWidth: '96vw', height: '90vh', display: 'flex', flexDirection: 'column', background: 'linear-gradient(180deg,#23232b,#1b1b21)', border: '1px solid var(--line)', borderRadius: 14, overflow: 'hidden', boxShadow: '0 24px 70px #000a' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderBottom: '1px solid var(--line)', flexShrink: 0 }}>
          <b style={{ fontSize: 16 }}>Admin</b>
          {data && <span style={{ fontSize: 12, color: 'var(--muted)' }}>{data.userCount} users · {humanBytes(data.totalBytes)} stored · {data.modders.length} modders</span>}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <div style={{ display: 'flex', border: '1px solid var(--line)', borderRadius: 6, overflow: 'hidden' }}>
              <button className="secondary" onClick={() => setTab('users')} style={{ borderRadius: 0, padding: '6px 12px', background: tab === 'users' ? 'var(--accent)' : 'var(--panel)', color: tab === 'users' ? '#fff' : 'var(--muted)' }}>Users</button>
              <button className="secondary" onClick={() => setTab('modders')} style={{ borderRadius: 0, padding: '6px 12px', background: tab === 'modders' ? 'var(--accent)' : 'var(--panel)', color: tab === 'modders' ? '#fff' : 'var(--muted)' }}>Modders</button>
            </div>
            <button className="secondary" onClick={onClose} aria-label="Close" style={{ width: 32, height: 32, padding: 0, display: 'grid', placeItems: 'center' }}>✕</button>
          </div>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 16 }}>
          {err && <div style={{ ...cardStyle, borderColor: '#5a2a2a', color: '#e79a9a' }}>{err}</div>}
          {!data && !err && <div style={{ color: 'var(--muted)', padding: 20, textAlign: 'center' }}>Loading…</div>}

          {data && tab === 'users' && (
            <div style={{ ...cardStyle, padding: 0, overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr>
                  <th style={th}>Email</th><th style={{ ...th, textAlign: 'right' }}>Storage</th>
                  <th style={{ ...th, textAlign: 'right' }}>% quota</th><th style={{ ...th, textAlign: 'right' }}>Shares</th>
                  <th style={th}>Joined</th><th style={th}>Last seen</th>
                </tr></thead>
                <tbody>
                  {data.users.map((u) => {
                    const pct = data.quotaBytes ? Math.min(100, Math.round((u.bytes / data.quotaBytes) * 100)) : 0;
                    return (
                      <tr key={u.id}>
                        <td style={{ ...td, maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis' }} title={u.email || u.id}>{u.email || <span style={{ color: 'var(--muted)' }}>{u.id.slice(0, 8)}…</span>}</td>
                        <td style={{ ...td, textAlign: 'right', fontFamily: 'ui-monospace,monospace' }}>{humanBytes(u.bytes)}</td>
                        <td style={{ ...td, textAlign: 'right' }}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                            <span style={{ width: 44, height: 5, borderRadius: 3, background: '#0e0e13', overflow: 'hidden', display: 'inline-block' }}>
                              <span style={{ display: 'block', height: '100%', width: `${pct}%`, background: pct > 85 ? '#c96b6b' : 'var(--accent)' }} />
                            </span>
                            <span style={{ color: 'var(--muted)', width: 30, textAlign: 'right' }}>{pct}%</span>
                          </span>
                        </td>
                        <td style={{ ...td, textAlign: 'right' }} title={Object.entries(u.kinds).map(([k, n]) => `${k}: ${n}`).join(', ')}>{u.count}</td>
                        <td style={{ ...td, color: 'var(--muted)' }}>{shortDate(u.created_at)}</td>
                        <td style={{ ...td, color: 'var(--muted)' }}>{shortDate(u.last_sign_in_at)}</td>
                      </tr>
                    );
                  })}
                  {!data.users.length && <tr><td style={{ ...td, color: 'var(--muted)' }} colSpan={6}>No users yet.</td></tr>}
                </tbody>
              </table>
            </div>
          )}

          {data && tab === 'modders' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {data.modders.map((m) => (
                <div key={m.steamid} style={cardStyle}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                    <b style={{ fontSize: 13.5 }}>{m.author || 'Unknown modder'}</b>
                    <a href={`https://steamcommunity.com/profiles/${m.steamid}`} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11.5, color: 'var(--muted)', fontFamily: 'ui-monospace,monospace' }}>{m.steamid}</a>
                    <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--muted)' }}>{m.allowed} allowed / {m.count} total</span>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {m.mods.map((mod) => (
                      <div key={mod.publishedfileid} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
                        <span style={{ width: 7, height: 7, borderRadius: '50%', background: statusColor(mod), flexShrink: 0 }} />
                        <a href={`https://steamcommunity.com/sharedfiles/filedetails/?id=${mod.publishedfileid}`} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--text)', textDecoration: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={mod.title || mod.publishedfileid}>{mod.title || mod.publishedfileid}</a>
                        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--muted)', flexShrink: 0 }}>{mod.status}{mod.host_status ? ` · ${mod.host_status}` : ''} · {shortDate(mod.consented_at)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
              {!data.modders.length && <div style={{ ...cardStyle, color: 'var(--muted)' }}>No modders have authed yet.</div>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
