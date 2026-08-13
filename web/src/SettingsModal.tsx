import { useEffect, useState } from 'react';
import { getSettings, setSettings, resetSettings, subscribeSettings, KEY_ACTIONS, NODE_ROLES, bindLabel, type Settings, type CamButton, type Bind } from './settings';

const CAM_BUTTONS: { id: CamButton; label: string }[] = [
  { id: 'left', label: 'Left mouse' },
  { id: 'right', label: 'Right mouse' },
  { id: 'middle', label: 'Middle (wheel) button' },
];

const input = { background: '#14141a', color: 'var(--text)', border: '1px solid var(--line)', borderRadius: 6, padding: '6px 9px', fontSize: 13 } as const;
const row = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '9px 0', borderBottom: '1px solid var(--line)' } as const;
const lbl = { fontSize: 13, color: 'var(--text)' } as const;
const sub = { fontSize: 11, color: 'var(--muted)', marginTop: 2 } as const;

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [s, setS] = useState<Settings>(getSettings());
  const [tab, setTab] = useState<'camera' | 'keys' | 'nodes'>('camera');
  const [capturing, setCapturing] = useState<string | null>(null);

  useEffect(() => subscribeSettings(setS), []);
  const apply = (next: Settings) => setSettings(next); // live: the engine + keybind handler react via the store
  const patchCam = (p: Partial<Settings['camera']>) => {
    const cam = { ...s.camera, ...p };
    if (p.orbit && p.orbit === s.camera.pan) cam.pan = s.camera.orbit; // keep orbit/pan on distinct buttons
    if (p.pan && p.pan === s.camera.orbit) cam.orbit = s.camera.pan;
    apply({ ...s, camera: cam });
  };
  const patchNodes = (p: Partial<Settings['nodes']>) => apply({ ...s, nodes: { ...s.nodes, ...p } });
  const setColor = (id: string, hex: string) => apply({ ...s, nodes: { ...s.nodes, colors: { ...s.nodes.colors, [id]: hex } } });

  // Keybind capture: while listening, the next keypress (other than Escape) becomes the bind.
  useEffect(() => {
    const action = capturing; if (!action) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault(); e.stopPropagation();
      if (e.key === 'Escape') { setCapturing(null); return; }
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return; // wait for the real key
      const b: Bind = { key: e.key.length === 1 ? e.key.toLowerCase() : e.key };
      if (e.ctrlKey || e.metaKey) b.ctrl = true;
      if (e.shiftKey) b.shift = true;
      if (e.altKey) b.alt = true;
      apply({ ...getSettings(), keys: { ...getSettings().keys, [action]: b } });
      setCapturing(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [capturing]); // eslint-disable-line react-hooks/exhaustive-deps

  const tabBtn = (id: typeof tab, label: string) => (
    <button className="secondary" onClick={() => setTab(id)}
      style={{ padding: '7px 14px', fontSize: 13, borderRadius: 6, border: `1px solid ${tab === id ? 'var(--accent)' : 'var(--line)'}`, background: tab === id ? 'var(--accent)' : 'var(--panel)', color: tab === id ? '#fff' : 'var(--text)' }}>{label}</button>
  );

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#000000aa', zIndex: 500, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 560, maxWidth: '94vw', maxHeight: '86vh', background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 10, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ padding: '13px 16px', borderBottom: '1px solid var(--line)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontWeight: 600, fontSize: 15 }}>Settings</span>
          <span role="button" onClick={onClose} title="Close" style={{ cursor: 'pointer', color: 'var(--muted)', padding: '0 4px', fontSize: 15 }}>✕</span>
        </div>
        <div style={{ display: 'flex', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--line)' }}>
          {tabBtn('camera', 'Camera')}{tabBtn('keys', 'Keybinds')}{tabBtn('nodes', 'Pose nodes')}
        </div>
        <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '10px 16px', borderBottom: '1px solid var(--line)', cursor: 'pointer' }}>
          <div><div style={lbl}>Developer mode</div><div style={sub}>Show extra developer / debug buttons in the UI (e.g. Export character data)</div></div>
          <input type="checkbox" checked={s.devMode} onChange={(e) => apply({ ...s, devMode: e.target.checked })} style={{ width: 18, height: 18, accentColor: 'var(--accent)' }} />
        </label>

        <div style={{ padding: '6px 16px 14px', overflow: 'auto' }}>
          {tab === 'camera' && (<>
            <div style={row}>
              <div><div style={lbl}>Orbit / rotate</div><div style={sub}>Drag with this button to rotate the camera</div></div>
              <select value={s.camera.orbit} onChange={(e) => patchCam({ orbit: e.target.value as CamButton })} style={{ ...input, minWidth: 170 }}>
                {CAM_BUTTONS.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
              </select>
            </div>
            <div style={row}>
              <div><div style={lbl}>Pan</div><div style={sub}>Drag with this button to slide the camera</div></div>
              <select value={s.camera.pan} onChange={(e) => patchCam({ pan: e.target.value as CamButton })} style={{ ...input, minWidth: 170 }}>
                {CAM_BUTTONS.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
              </select>
            </div>
            <div style={row}>
              <div><div style={lbl}>Rotate speed</div><div style={sub}>{s.camera.rotateSpeed.toFixed(2)}x</div></div>
              <input type="range" min={0.25} max={3} step={0.05} value={s.camera.rotateSpeed} onChange={(e) => patchCam({ rotateSpeed: +e.target.value })} style={{ width: 200 }} />
            </div>
            <div style={row}>
              <div><div style={lbl}>Zoom speed</div><div style={sub}>{s.camera.zoomSpeed.toFixed(2)}x</div></div>
              <input type="range" min={0.25} max={3} step={0.05} value={s.camera.zoomSpeed} onChange={(e) => patchCam({ zoomSpeed: +e.target.value })} style={{ width: 200 }} />
            </div>
            <label style={{ ...row, cursor: 'pointer' }}>
              <div><div style={lbl}>Invert scroll zoom</div><div style={sub}>Scroll up zooms out instead of in</div></div>
              <input type="checkbox" checked={s.camera.invertZoom} onChange={(e) => patchCam({ invertZoom: e.target.checked })} style={{ width: 18, height: 18, accentColor: 'var(--accent)' }} />
            </label>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 10, lineHeight: 1.5 }}>Zoom always stays on the scroll wheel. Selecting, placing props and posing use the left mouse regardless of these bindings.</div>
          </>)}

          {tab === 'keys' && (<>
            {KEY_ACTIONS.map((a) => (
              <div key={a.id} style={row}>
                <div style={lbl}>{a.label}</div>
                <button className="secondary" onClick={() => setCapturing(a.id)}
                  title="Click, then press the key combination to bind"
                  style={{ minWidth: 150, padding: '6px 12px', fontSize: 13, borderRadius: 6, fontFamily: capturing === a.id ? undefined : 'ui-monospace, monospace', border: `1px solid ${capturing === a.id ? 'var(--accent)' : 'var(--line)'}`, background: capturing === a.id ? 'var(--accent)' : 'var(--panel)', color: capturing === a.id ? '#fff' : 'var(--text)' }}>
                  {capturing === a.id ? 'Press keys... (Esc cancels)' : bindLabel(s.keys[a.id])}
                </button>
              </div>
            ))}
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 10, lineHeight: 1.5 }}>Click a binding, then press the keys you want (hold Ctrl / Shift / Alt for a modifier). These fire only in the character viewer, not while typing in a field.</div>
          </>)}

          {tab === 'nodes' && (<>
            <div style={row}>
              <div><div style={lbl}>Node size</div><div style={sub}>{s.nodes.scale.toFixed(2)}x</div></div>
              <input type="range" min={0.4} max={2.5} step={0.05} value={s.nodes.scale} onChange={(e) => patchNodes({ scale: +e.target.value })} style={{ width: 200 }} />
            </div>
            <div style={row}>
              <div><div style={lbl}>Node opacity</div><div style={sub}>Resting nodes - {Math.round(s.nodes.opacity * 100)}%</div></div>
              <input type="range" min={0.1} max={1} step={0.05} value={s.nodes.opacity} onChange={(e) => patchNodes({ opacity: +e.target.value })} style={{ width: 200 }} />
            </div>
            <div style={row}>
              <div><div style={lbl}>Selected node opacity</div><div style={sub}>Selected / hovered nodes - {Math.round(s.nodes.selectedOpacity * 100)}%</div></div>
              <input type="range" min={0.1} max={1} step={0.05} value={s.nodes.selectedOpacity} onChange={(e) => patchNodes({ selectedOpacity: +e.target.value })} style={{ width: 200 }} />
            </div>
            {NODE_ROLES.map((r) => (
              <div key={r.id} style={row}>
                <div style={lbl}>{r.label}</div>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12, color: 'var(--muted)' }}>{s.nodes.colors[r.id]}</span>
                  <input type="color" value={s.nodes.colors[r.id]} onChange={(e) => setColor(r.id, e.target.value)} style={{ width: 34, height: 26, padding: 0, border: '1px solid var(--line)', borderRadius: 6, background: 'transparent', cursor: 'pointer' }} />
                </span>
              </div>
            ))}
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 10, lineHeight: 1.5 }}>Applies to the draggable pose-editor handles. Selected and hovered nodes still show their highlight and larger size.</div>
          </>)}
        </div>

        <div style={{ padding: '11px 16px', borderTop: '1px solid var(--line)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <button className="secondary" onClick={() => { if (confirm('Reset all settings to defaults?')) resetSettings(); }} style={{ padding: '7px 14px', fontSize: 12.5, borderRadius: 6, border: '1px solid var(--line)', color: 'var(--muted)' }}>Reset to defaults</button>
          <button onClick={onClose} style={{ padding: '7px 18px', fontSize: 13 }}>Done</button>
        </div>
      </div>
    </div>
  );
}
