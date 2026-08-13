import { useState, type CSSProperties, type ReactNode } from 'react';
import { nativeBridge } from './platform/native-fs';
import { getSettings, bindLabel } from './settings';
import type { CharacterEngine } from './render/character-engine';
import type { PoseEditor } from './usePoseEditor';

type PoseEditorPanelProps = {
  pose: PoseEditor;
  engine: CharacterEngine | null;
  editState: { clip: string | null; bones: string[] };
  selectedBones: string[];
  saveAsName: string;
  setSaveAsName: (v: string) => void;
  boneSearch: string;
  isMobile: boolean;
  bottomBarH: number;
  boneTick: number;         // re-read engine values after each edit
  bump: () => void;
};

export function PoseEditorPanel({ pose, engine, editState, selectedBones, saveAsName, setSaveAsName, boneSearch, isMobile, bottomBarH, boneTick, bump }: PoseEditorPanelProps) {
  void boneTick; // read fresh after each setBoneEdit
  const eng = engine;
  const [panelCollapsed, setPanelCollapsed] = useState(false); // chevron collapses the panel to just its header
  const [helpOpen, setHelpOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const { collapsed, setCollapsed, posePresets, setPosesOpen, savePose, requestSave, saveOpen, setSaveOpen, saveName, setSaveName, dirty, downloadEditedX, saveToFolder, downloadAllEdited } = pose;
  const primary = selectedBones.length ? selectedBones[selectedBones.length - 1] : null;
  const cur = primary && eng ? eng.boneEditOf(primary) : null;
  const edited = new Set(eng?.editedBoneNames() || []);
  const retimed = (eng?.lengthScaleOf() ?? 1) !== 1 || (eng?.clipEndOf() ?? null) !== null; // clip retimed/trimmed even without bone edits
  const savable = edited.size > 0 || retimed;
  const clip = eng?.clipboardSize() ?? 0;
  const editedClips = eng?.editedClips() ?? []; // all clips (this session) that carry edits
  const bones = editState.bones.filter((b) => b.toLowerCase().includes(boneSearch.toLowerCase()));
  const secLabel: CSSProperties = { fontSize: 10, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--muted)', marginBottom: 4 };
  const setRot = (i: number, v: number) => { if (!primary || !cur) return; const eu = [...cur.euler] as [number, number, number]; eu[i] = v; eng!.setBoneEdit(primary, eu, cur.pos); bump(); };
  const setPos = (i: number, v: number) => { if (!primary || !cur) return; const p = [...cur.pos] as [number, number, number]; p[i] = v; eng!.setBoneEdit(primary, cur.euler, p); bump(); };
  const axis = ['X', 'Y', 'Z'];
  const secHead = (id: string, label: string) => (
    <div onClick={() => setCollapsed((c) => ({ ...c, [id]: !c[id] }))} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', userSelect: 'none' }} title={collapsed[id] ? 'Expand' : 'Collapse'}>
      <span style={{ fontSize: 8, color: 'var(--muted)', display: 'inline-block', width: 9, transform: collapsed[id] ? 'rotate(-90deg)' : 'none', transition: 'transform .12s' }}>{'▼'}</span>
      <span style={{ ...secLabel, marginBottom: 0 }}>{label}</span>
    </div>
  );
  return (
    <div style={{ position: 'absolute', right: isMobile ? 6 : 12, top: isMobile ? 48 : 54, bottom: (panelCollapsed || isMobile) ? undefined : bottomBarH + 20, width: isMobile ? 'min(320px, calc(100% - 12px))' : 300, maxHeight: isMobile ? '82%' : undefined, overflowY: 'auto', overflowX: 'hidden', background: '#0e0e13f2', border: '1px solid var(--line)', borderRadius: 8, padding: 10, boxShadow: '0 12px 34px -14px rgba(0,0,0,.7)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: panelCollapsed ? 0 : 8 }}>
        <span style={{ fontSize: 12, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Editing {editState.clip}</span>
        <span style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
          <button className="secondary" onClick={() => setHelpOpen(true)} title="How the pose editor works (hotkeys)" aria-label="Pose editor help" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: 0, width: 22, height: 22, borderRadius: 6, border: '1px solid var(--line)' }}>
            <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><circle cx={12} cy={12} r={10} /><path d="M9.6 9.3a2.5 2.5 0 0 1 4.6 1.3c0 1.7-2.1 1.8-2.5 3.2" /><path d="M12 17.2h.01" /></svg>
          </button>
          <button className="secondary" onClick={() => setPanelCollapsed((v) => !v)} title={panelCollapsed ? 'Expand panel' : 'Collapse panel'} aria-label={panelCollapsed ? 'Expand panel' : 'Collapse panel'} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: 0, width: 22, height: 22, borderRadius: 6, border: '1px solid var(--line)' }}>
            <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" style={{ transform: panelCollapsed ? 'none' : 'rotate(180deg)', transition: 'transform .15s' }}><path d="M6 9l6 6 6-6" /></svg>
          </button>
          <span role="button" onClick={() => eng?.exitEditMode()} title="Exit pose editing" style={{ cursor: 'pointer', color: 'var(--muted)', padding: '0 4px' }}>✕</span>
        </span>
      </div>
      {!panelCollapsed && (<>
      {eng && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 9 }}>
          <span style={{ fontSize: 9.5, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--muted)', marginRight: 1 }}>Nodes</span>
          <IconToggle active={eng.propNodesOn()} onClick={() => { eng.setPropNodes(!eng.propNodesOn()); bump(); }} title="Show prop (hand-attachment) nodes"><IcoSword /></IconToggle>
          <IconToggle active={eng.fingerNodesOn()} onClick={() => { eng.setFingerNodes(!eng.fingerNodesOn()); bump(); }} title="Show finger & thumb nodes"><IcoHand /></IconToggle>
          <span style={{ flex: 1 }} />
          <IconAction onClick={() => setExportOpen(true)} title="Save & export the edited animation"><IcoDownload /></IconAction>
          <span style={{ position: 'relative', display: 'inline-flex' }}>
            <IconAction onClick={requestSave} disabled={!savable} title={dirty && savable ? 'Save the current pose (Ctrl+S) - unsaved changes' : 'Save the current pose (Ctrl+S)'}><IcoSave /></IconAction>
            {dirty && savable && <span title="Unsaved pose changes" style={{ position: 'absolute', top: -2, right: -2, width: 7, height: 7, borderRadius: 999, background: '#ffd23f', border: '1px solid #0e0e13', pointerEvents: 'none' }} />}
          </span>
          <IconAction onClick={() => setPosesOpen(true)} title="Browse saved poses" label={Object.keys(posePresets).length ? String(Object.keys(posePresets).length) : undefined}><IcoBookmark /></IconAction>
        </div>
      )}
      <div style={{ borderTop: '1px solid var(--line)', marginTop: 8, paddingTop: 8 }}>
        {secHead('bones', 'Bones')}
        {!collapsed.bones && <div style={{ maxHeight: 168, overflow: 'auto', border: '1px solid var(--line)', borderRadius: 6, marginTop: 6 }}>
        {bones.map((b) => {
          const sel = selectedBones.includes(b);
          return (
            <div key={b} onClick={(e) => (e.shiftKey ? eng?.toggleBone(b) : eng?.selectBone(b))}
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', fontSize: 11.5, cursor: 'pointer', background: sel ? 'var(--accent)' : 'transparent', color: sel ? '#fff' : 'var(--text)' }}>
              <span style={{ width: 6, height: 6, borderRadius: 999, flexShrink: 0, background: edited.has(b) ? '#33cc66' : 'transparent', border: edited.has(b) ? 'none' : '1px solid var(--line)' }} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.replace(/^Bip01_?/, '')}</span>
            </div>
          );
        })}
        {!bones.length && <div style={{ padding: 8, fontSize: 11, color: 'var(--muted)' }}>no bones match</div>}
      </div>}
      </div>
      {primary && cur ? (
        <div style={{ borderTop: '1px solid var(--line)', marginTop: 10, paddingTop: 9 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <span style={{ fontSize: 11.5, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{primary.replace(/^Bip01_?/, '')}{selectedBones.length > 1 ? ` (+${selectedBones.length - 1})` : ''}</span>
            <div style={{ display: 'flex', gap: 5, flexShrink: 0 }}>
              <button className="secondary" title="Copy the selected bone(s) keyframes" onClick={() => { eng?.copyBones(); bump(); }} style={{ padding: '3px 8px', fontSize: 11, borderRadius: 6, border: '1px solid var(--line)' }}>copy</button>
              <button className="secondary" title={clip ? `Paste ${clip} copied bone(s) onto the selection` : 'Copy a bone first'} disabled={!clip} onClick={() => { eng?.pasteBones(); bump(); }} style={{ padding: '3px 8px', fontSize: 11, borderRadius: 6, border: '1px solid var(--line)', opacity: clip ? 1 : 0.5, cursor: clip ? 'pointer' : 'default' }}>paste</button>
              <button className="secondary" title={clip ? 'Paste the copied bone(s) mirrored onto the opposite side' : 'Copy a bone first'} disabled={!clip} onClick={() => { eng?.pasteMirror(); bump(); }} style={{ padding: '3px 8px', fontSize: 11, borderRadius: 6, border: '1px solid var(--line)', opacity: clip ? 1 : 0.5, cursor: clip ? 'pointer' : 'default' }}>paste L/R</button>
              <button className="secondary" onClick={() => { eng?.resetBones([primary]); bump(); }} style={{ padding: '3px 8px', fontSize: 11, borderRadius: 6, border: '1px solid var(--line)' }}>reset</button>
            </div>
          </div>
          {eng && eng.isPropBone(primary) && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '2px 0 8px', fontSize: 11.5, color: 'var(--text)', cursor: 'pointer' }}
              title="On: the prop follows the hand and your edits are offsets from it. Off: animate the prop freely, independent of the hand (based on its rest pose).">
              <input type="checkbox" checked={eng.propFollowOf(primary)} onChange={(e) => { eng.setPropFollow(primary, e.target.checked); bump(); }} style={{ accentColor: 'var(--accent)' }} />
              Follow hand <span style={{ fontSize: 10, color: 'var(--muted)' }}>{eng.propFollowOf(primary) ? '(offset)' : '(independent)'}</span>
            </label>
          )}
          {secHead('transform', 'Transform')}
          {!collapsed.transform && (<>
          <div style={{ ...secLabel, marginTop: 6 }}>Rotation (deg)</div>
          {[0, 1, 2].map((i) => (
            <div key={`r${i}`} style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 4 }}>
              <span style={{ width: 12, fontSize: 11, color: 'var(--muted)' }}>{axis[i]}</span>
              <input type="range" min={-180} max={180} step={1} value={cur.euler[i]} onChange={(e) => setRot(i, Number(e.target.value))} style={{ flex: 1, minWidth: 0, accentColor: '#5b8cff' }} />
              <input type="number" value={Math.round(cur.euler[i])} onChange={(e) => setRot(i, Number(e.target.value))} style={{ width: 48, fontSize: 11, padding: '2px 4px', borderRadius: 5, border: '1px solid var(--line)', background: 'var(--panel)', color: 'var(--text)' }} />
            </div>
          ))}
          <div style={{ ...secLabel, marginTop: 8 }}>Offset</div>
          {[0, 1, 2].map((i) => (
            <div key={`p${i}`} style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 4 }}>
              <span style={{ width: 12, fontSize: 11, color: 'var(--muted)' }}>{axis[i]}</span>
              <input type="range" min={-0.5} max={0.5} step={0.005} value={cur.pos[i]} onChange={(e) => setPos(i, Number(e.target.value))} style={{ flex: 1, minWidth: 0, accentColor: '#5b8cff' }} />
              <input type="number" step={0.01} value={Number(cur.pos[i].toFixed(3))} onChange={(e) => setPos(i, Number(e.target.value))} style={{ width: 48, fontSize: 11, padding: '2px 4px', borderRadius: 5, border: '1px solid var(--line)', background: 'var(--panel)', color: 'var(--text)' }} />
            </div>
          ))}
          </>)}
        </div>
      ) : (
        <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 8 }}>Click a joint on the character or a bone above to select it. Scrub to pose at a frame.</div>
      )}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 10, fontSize: 10.5, color: 'var(--muted)' }}>
        <span>{edited.size} bone{edited.size === 1 ? '' : 's'} edited</span>
        {edited.size > 0 && <div style={{ display: 'flex', gap: 6 }}>
          <button className="secondary" onClick={() => { eng?.mirrorAnimation(); bump(); }} title="Mirror the whole animation left to right (every keyframe)" style={{ padding: '3px 8px', fontSize: 11, borderRadius: 6, border: '1px solid var(--line)' }}>mirror L/R</button>
          <button className="secondary" onClick={() => { eng?.clearBoneEdits(); bump(); }} style={{ padding: '3px 8px', fontSize: 11, borderRadius: 6, border: '1px solid var(--line)' }}>clear all</button>
        </div>}
      </div>
      </>)}
      {exportOpen && (
        <ModalShell title="Save & export animation" onClose={() => setExportOpen(false)}>
          <div style={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.5, marginBottom: 10 }}>Name the AnimationSet so vanilla is never overwritten. Clear the name to overwrite <b>{editState.clip}</b> in place.</div>
          <input value={saveAsName} onChange={(e) => setSaveAsName(e.target.value)} placeholder={editState.clip || 'AnimationSet name'}
            style={{ width: '100%', boxSizing: 'border-box', fontSize: 13, padding: '8px 10px', borderRadius: 6, border: '1px solid var(--line)', background: '#14141a', color: 'var(--text)' }} />
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button disabled={!savable} onClick={() => { downloadEditedX(); setExportOpen(false); }} title={savable ? 'Bake the edits into an .x and download it' : 'Edit a bone or retime the clip first'}
              style={{ flex: 1, padding: '9px 12px', fontSize: 13, borderRadius: 6, cursor: savable ? 'pointer' : 'default', border: `1px solid ${savable ? 'var(--accent)' : 'var(--line)'}`, background: savable ? 'var(--accent)' : 'var(--panel)', color: savable ? '#fff' : 'var(--muted)' }}>Download .x</button>
            {!!nativeBridge()?.writeFile && (
              <button className="secondary" disabled={!savable} onClick={() => { saveToFolder(); setExportOpen(false); }} title="Write the edited .x into a mod folder you pick"
                style={{ flex: 1, padding: '9px 12px', fontSize: 13, borderRadius: 6, cursor: savable ? 'pointer' : 'default', border: '1px solid var(--line)', background: 'var(--panel)', color: savable ? 'var(--text)' : 'var(--muted)' }}>Save to folder...</button>
            )}
          </div>
          {editedClips.length > 1 && (<>
            <div style={{ borderTop: '1px solid var(--line)', margin: '14px 0 12px' }} />
            <button className="secondary" onClick={() => { downloadAllEdited(); setExportOpen(false); }} title="Bake all edited clips to renamed .x and download as a zip"
              style={{ width: '100%', padding: '9px 12px', fontSize: 13, borderRadius: 6, cursor: 'pointer', border: '1px solid var(--line)', background: 'var(--panel)', color: 'var(--text)' }}>Download all {editedClips.length} edited clips (.zip)</button>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 7, lineHeight: 1.5 }}>Edits persist as you switch clips this session. Each is baked with an _Edited AnimationSet name.</div>
          </>)}
        </ModalShell>
      )}
      {saveOpen && (
        <ModalShell title="Save pose" onClose={() => setSaveOpen(false)}>
          <div style={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.5, marginBottom: 10 }}>Save the current edits as a reusable pose (stored locally). Load it later from the saved poses browser.</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input value={saveName} onChange={(e) => setSaveName(e.target.value)} placeholder="pose name" autoFocus
              onKeyDown={(e) => { if (e.key === 'Enter' && saveName.trim()) { savePose(saveName.trim()); setSaveOpen(false); } }}
              style={{ flex: 1, minWidth: 0, boxSizing: 'border-box', fontSize: 13, padding: '8px 10px', borderRadius: 6, border: '1px solid var(--line)', background: '#14141a', color: 'var(--text)' }} />
            <button disabled={!saveName.trim()} onClick={() => { savePose(saveName.trim()); setSaveOpen(false); }}
              style={{ padding: '8px 18px', fontSize: 13, borderRadius: 6, border: `1px solid ${saveName.trim() ? 'var(--accent)' : 'var(--line)'}`, background: saveName.trim() ? 'var(--accent)' : 'var(--panel)', color: saveName.trim() ? '#fff' : 'var(--muted)', cursor: saveName.trim() ? 'pointer' : 'default' }}>Save</button>
          </div>
        </ModalShell>
      )}
      {helpOpen && <HelpModal onClose={() => setHelpOpen(false)} />}
    </div>
  );
}

function ModalShell({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: '#000000aa', zIndex: 450, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 440, maxWidth: '92vw', maxHeight: '84vh', overflow: 'auto', background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 10, padding: 18 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <span style={{ fontWeight: 600, fontSize: 15 }}>{title}</span>
          <span role="button" onClick={onClose} title="Close" style={{ cursor: 'pointer', color: 'var(--muted)', padding: '0 4px', fontSize: 15 }}>✕</span>
        </div>
        {children}
      </div>
    </div>
  );
}

function HelpModal({ onClose }: { onClose: () => void }) {
  const k = getSettings().keys;
  const row = (label: string, val: string) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '5px 0', borderBottom: '1px solid var(--line)', fontSize: 12.5 }}>
      <span style={{ color: 'var(--text)' }}>{label}</span>
      <span style={{ color: 'var(--muted)', fontFamily: 'ui-monospace, monospace', whiteSpace: 'nowrap' }}>{val}</span>
    </div>
  );
  const dot = (c: string) => <span style={{ width: 9, height: 9, borderRadius: 999, background: c, display: 'inline-block', flexShrink: 0 }} />;
  const legend = (c: string, text: string) => <li style={{ display: 'flex', alignItems: 'center', gap: 7, margin: '3px 0' }}>{dot(c)}<span>{text}</span></li>;
  return (
    <ModalShell title="Pose editor" onClose={onClose}>
      <div style={{ fontSize: 12.5, color: 'var(--text)', lineHeight: 1.55 }}>
        <p style={{ margin: '0 0 8px' }}>Drag the coloured handles on the character to pose the current animation. Scrub the timeline and pose again to add a keyframe (the dopesheet is below the view).</p>
        <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--muted)', margin: '12px 0 4px' }}>Handles (default colours)</div>
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, fontSize: 12.5 }}>
          {legend('#5b8cff', 'Hands & feet reach a target (IK)')}
          {legend('#ff3db1', 'Elbows & knees set the bend direction')}
          {legend('#33cc99', 'Spine, chest, head & fingers aim/bend')}
          {legend('#cc66ff', 'Hips move the whole body')}
          {legend('#ffb034', 'Prop nodes sit in the hands')}
        </ul>
        <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--muted)', margin: '14px 0 4px' }}>Handling</div>
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          <li>Shift-click handles (or bones in the list) to select several, then drag one to move them all.</li>
          <li>Click empty space to deselect. Right-click a handle to reset that limb.</li>
          <li>With a node selected, press <b>G</b> to move it or <b>R</b> to rotate it with the mouse, then <b>X</b> / <b>Y</b> / <b>Z</b> to lock the axis. Click or Enter confirms, Esc cancels.</li>
          <li>Scroll while holding a node to rotate it; press R to switch the rotation axis (screen / X / Y / Z).</li>
          <li>Toggle the prop and finger node buttons in the panel to show those handles.</li>
        </ul>
        <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--muted)', margin: '14px 0 4px' }}>Hotkeys</div>
        {row('Undo / Redo', `${bindLabel(k.undo)} / ${bindLabel(k.redo)}`)}
        {row('Save pose', bindLabel(k.savePose))}
        {row('Copy / Paste keyframes', `${bindLabel(k.copyKeys)} / ${bindLabel(k.pasteKeys)}`)}
        {row('Delete selection', bindLabel(k.delete))}
        {row('Deselect / cancel', bindLabel(k.deselect))}
        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 10, lineHeight: 1.5 }}>Hotkeys, node colours and camera controls are configurable in Settings (the gear button, top right).</div>
      </div>
    </ModalShell>
  );
}

const iconBtnBase: CSSProperties = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4, height: 28, borderRadius: 6, cursor: 'pointer', flexShrink: 0 };
function IconToggle({ active, onClick, title, children }: { active: boolean; onClick: () => void; title: string; children: ReactNode }) {
  return (
    <button className="secondary" onClick={onClick} title={title} aria-pressed={active}
      style={{ ...iconBtnBase, width: 30, padding: 0, border: `1px solid ${active ? 'var(--accent)' : 'var(--line)'}`, background: active ? 'var(--accent)' : 'var(--panel)', color: active ? '#fff' : 'var(--text)' }}>{children}</button>
  );
}
function IconAction({ onClick, title, label, disabled, children }: { onClick: () => void; title: string; label?: string; disabled?: boolean; children: ReactNode }) {
  return (
    <button className="secondary" onClick={onClick} title={title} disabled={disabled}
      style={{ ...iconBtnBase, padding: label ? '0 8px' : 0, width: label ? undefined : 30, border: '1px solid var(--line)', background: 'var(--panel)', color: 'var(--text)', opacity: disabled ? 0.45 : 1, cursor: disabled ? 'default' : 'pointer' }}>
      {children}{label && <span style={{ fontSize: 11, color: 'var(--muted)' }}>{label}</span>}
    </button>
  );
}
const IcoSword = () => <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><path d="M14.5 17.5 3 6V3h3l11.5 11.5" /><path d="M13 19l6-6" /><path d="M16 16l4 4" /><path d="M19 21l2-2" /></svg>;
const IcoHand = () => <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><path d="M7 11V5.5a1.5 1.5 0 0 1 3 0V11" /><path d="M10 11V4.5a1.5 1.5 0 0 1 3 0V11" /><path d="M13 11V5.5a1.5 1.5 0 0 1 3 0V12" /><path d="M16 12v-.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-1.5a5 5 0 0 1-3.6-1.5L4 15.6a1.6 1.6 0 0 1 2.3-2.2L7.5 14" /></svg>;
const IcoDownload = () => <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12" /><path d="M7 10l5 5 5-5" /><path d="M4 20h16" /></svg>;
const IcoSave = () => <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" /><path d="M17 21v-8H7v8" /><path d="M7 3v5h8" /></svg>;
const IcoBookmark = () => <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round"><path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z" /></svg>;
