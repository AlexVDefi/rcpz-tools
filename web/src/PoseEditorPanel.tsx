import { useState, type CSSProperties } from 'react';
import { nativeBridge } from './platform/native-fs';
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
  const { collapsed, setCollapsed, poseName, setPoseName, posePresets, setPosesOpen, savePose, downloadEditedX, saveToFolder, downloadAllEdited } = pose;
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
          <button className="secondary" onClick={() => setPanelCollapsed((v) => !v)} title={panelCollapsed ? 'Expand panel' : 'Collapse panel'} aria-label={panelCollapsed ? 'Expand panel' : 'Collapse panel'} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: 0, width: 22, height: 22, borderRadius: 6, border: '1px solid var(--line)' }}>
            <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" style={{ transform: panelCollapsed ? 'none' : 'rotate(180deg)', transition: 'transform .15s' }}><path d="M6 9l6 6 6-6" /></svg>
          </button>
          <span role="button" onClick={() => eng?.exitEditMode()} title="Exit pose editing" style={{ cursor: 'pointer', color: 'var(--muted)', padding: '0 4px' }}>✕</span>
        </span>
      </div>
      {!panelCollapsed && (<>
      <div style={{ fontSize: 10, color: 'var(--muted)', marginBottom: 8, lineHeight: 1.4 }}>Drag a handle to pose. Blue hands/feet reach (IK); pink elbows/knees set the bend; teal spine/chest/head bend the torso; purple hips move the body; orange prop nodes sit in the hands. Scrub the timeline and pose again to keyframe (dopesheet below).</div>
      {eng && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, fontSize: 11.5, color: 'var(--text)', cursor: 'pointer' }} title="Show the orange prop (hand-attachment) nodes in the viewport so you can drag them">
          <input type="checkbox" checked={eng.propNodesOn()} onChange={(e) => { eng.setPropNodes(e.target.checked); bump(); }} style={{ accentColor: 'var(--accent)' }} />
          Show prop nodes
        </label>
      )}
      {eng && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, fontSize: 11.5, color: 'var(--text)', cursor: 'pointer' }} title="Show the finger and thumb nodes in the viewport so you can pose the hands">
          <input type="checkbox" checked={eng.fingerNodesOn()} onChange={(e) => { eng.setFingerNodes(e.target.checked); bump(); }} style={{ accentColor: 'var(--accent)' }} />
          Show finger nodes
        </label>
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
      <div style={{ borderTop: '1px solid var(--line)', marginTop: 10, paddingTop: 9 }}>
        {secHead('save', 'Save & export')}
        {!collapsed.save && (<div style={{ marginTop: 6 }}>
        <input value={saveAsName} onChange={(e) => setSaveAsName(e.target.value)} placeholder={editState.clip || 'AnimationSet name'}
          style={{ width: '100%', boxSizing: 'border-box', fontSize: 12, padding: '5px 7px', borderRadius: 6, border: '1px solid var(--line)', background: 'var(--panel)', color: 'var(--text)' }} />
        <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
          <button className="secondary" onClick={downloadEditedX} disabled={!savable} title={savable ? 'Bake the edits into an .x and download it' : 'Edit a bone or retime the clip first'}
            style={{ flex: 1, padding: '6px 10px', fontSize: 12, borderRadius: 6, cursor: savable ? 'pointer' : 'default', border: `1px solid ${savable ? 'var(--accent)' : 'var(--line)'}`, background: savable ? 'var(--accent)' : 'var(--panel)', color: savable ? '#fff' : 'var(--muted)' }}>Download .x</button>
          {!!nativeBridge()?.writeFile && (
            <button className="secondary" onClick={saveToFolder} disabled={!savable} title="Write the edited .x into a mod folder you pick"
              style={{ flex: 1, padding: '6px 10px', fontSize: 12, borderRadius: 6, cursor: savable ? 'pointer' : 'default', border: '1px solid var(--line)', background: 'var(--panel)', color: savable ? 'var(--text)' : 'var(--muted)' }}>Save to folder...</button>
          )}
        </div>
        <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 5, lineHeight: 1.4 }}>Renames the AnimationSet so vanilla is never overwritten. Clear the name to overwrite {editState.clip} in place.</div>
        {editedClips.length > 1 && (
          <div style={{ marginTop: 8 }}>
            <button className="secondary" onClick={downloadAllEdited} title="Bake all edited clips to renamed .x and download as a zip"
              style={{ width: '100%', padding: '6px 10px', fontSize: 12, borderRadius: 6, cursor: 'pointer', border: '1px solid var(--line)', background: 'var(--panel)', color: 'var(--text)' }}>Download all edited (.zip)</button>
            <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 5, lineHeight: 1.4 }}>Edits persist as you switch clips this session. Each is baked with an _Edited AnimationSet name.</div>
          </div>
        )}
        </div>)}
      </div>
      <div style={{ borderTop: '1px solid var(--line)', marginTop: 10, paddingTop: 9 }}>
        {secHead('poses', `Saved poses${Object.keys(posePresets).length ? ` (${Object.keys(posePresets).length})` : ''}`)}
        {!collapsed.poses && (<div style={{ marginTop: 6 }}>
          <div style={{ display: 'flex', gap: 6 }}>
            <input value={poseName} onChange={(e) => setPoseName(e.target.value)} placeholder="name this pose" onKeyDown={(e) => { if (e.key === 'Enter') { savePose(poseName); setPoseName(''); } }}
              style={{ flex: 1, minWidth: 0, boxSizing: 'border-box', fontSize: 12, padding: '5px 7px', borderRadius: 6, border: '1px solid var(--line)', background: 'var(--panel)', color: 'var(--text)' }} />
            <button className="secondary" disabled={!savable} title={savable ? 'Save the current edits as a reusable pose (Ctrl+S)' : 'Edit something first'} onClick={() => { savePose(poseName || saveAsName || editState.clip || 'pose'); setPoseName(''); }}
              style={{ flexShrink: 0, padding: '6px 14px', fontSize: 12, borderRadius: 6, border: `1px solid ${savable ? 'var(--accent)' : 'var(--line)'}`, background: savable ? 'var(--accent)' : 'var(--panel)', color: savable ? '#fff' : 'var(--muted)', cursor: savable ? 'pointer' : 'default' }}>save</button>
          </div>
          <button className="secondary" onClick={() => setPosesOpen(true)} title="Browse your saved poses as a gallery" style={{ width: '100%', marginTop: 6, padding: '6px 10px', fontSize: 12, borderRadius: 6, cursor: 'pointer', border: '1px solid var(--line)', background: 'var(--panel)', color: 'var(--text)' }}>Browse saved poses{Object.keys(posePresets).length ? ` (${Object.keys(posePresets).length})` : ''}...</button>
          <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 5, lineHeight: 1.4 }}>Saved locally. Ctrl+S quick-saves. Load applies a saved pose onto the current clip.</div>
        </div>)}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 10, fontSize: 10.5, color: 'var(--muted)' }}>
        <span>{edited.size} bone{edited.size === 1 ? '' : 's'} edited</span>
        {edited.size > 0 && <div style={{ display: 'flex', gap: 6 }}>
          <button className="secondary" onClick={() => { eng?.mirrorAnimation(); bump(); }} title="Mirror the whole animation left to right (every keyframe)" style={{ padding: '3px 8px', fontSize: 11, borderRadius: 6, border: '1px solid var(--line)' }}>mirror L/R</button>
          <button className="secondary" onClick={() => { eng?.clearBoneEdits(); bump(); }} style={{ padding: '3px 8px', fontSize: 11, borderRadius: 6, border: '1px solid var(--line)' }}>clear all</button>
        </div>}
      </div>
      <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 6, lineHeight: 1.4 }}>Right-click a handle to reset that limb. Ctrl+Z / Ctrl+Y to undo/redo.</div>
      </>)}
    </div>
  );
}
