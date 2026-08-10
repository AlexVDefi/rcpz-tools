import { useEffect, useState } from 'react';
import { nativeBridge } from './platform/native-fs';
import { makeZip } from './anim-edit/zip';
import type { CharacterEngine } from './render/character-engine';

export type PoseData = { clip: string; rel?: string; format?: string; id?: string; lo?: number; hi?: number; lengthScale: number; clipEnd: number | null; bones: Record<string, { tick: number; rot: number[]; pos: number[] }[]>; saved?: number; thumb?: string }; // a saved animation-edit (rel/format/id + lo/hi let the poses browser auto-play the edited clip)

type UsePoseEditorArgs = {
  engineRef: React.RefObject<CharacterEngine | null>;
  editState: { active: boolean; clip: string | null };
  saveAsName: string;                                          // owned by the parent (reset from the engine's edit-state callback)
  clips: NonNullable<Parameters<CharacterEngine['bakeAll']>[0]>; // full clip list, for the bulk export
  capture: () => string | undefined;                           // parent's front snapshot (shared with character presets)
  bump: () => void;                                            // request a re-render after mutating the engine
  toast: (msg: string) => void;
};

// The pose editor's library + export logic: saved-pose presets (localStorage), the panel's local UI
// state (name/collapsed/browser-open), and every bake/save/load operation. Kept out of CharacterViewer
// so the component tree only carries the panel markup.
export function usePoseEditor({ engineRef, editState, saveAsName, clips, capture, bump, toast }: UsePoseEditorArgs) {
  const [posePresets, setPosePresets] = useState<Record<string, PoseData>>(() => { try { return JSON.parse(localStorage.getItem('pz-pose-presets') || '{}'); } catch { return {}; } }); // saved animation-edit "poses"
  useEffect(() => { localStorage.setItem('pz-pose-presets', JSON.stringify(posePresets)); }, [posePresets]);
  const [poseName, setPoseName] = useState('');
  const [posesOpen, setPosesOpen] = useState(false); // saved-poses browser modal
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({}); // collapsed pose-panel sections

  const savePose = (name: string) => {
    const n = name.trim(); if (!n) { toast('name the pose first'); return; }
    const d = engineRef.current?.exportClipEdit();
    if (!d) { toast('nothing to save (no edits yet)'); return; }
    setPosePresets((p) => ({ ...p, [n]: { ...d, thumb: capture(), saved: Date.now() } }));
    toast(`saved pose "${n}"`);
  };
  const loadPose = (name: string) => {
    const d = posePresets[name], eng = engineRef.current; if (!d || !eng) return;
    if (!editState.active && eng.canEditClip()) eng.enterEditMode();
    eng.applyClipEdit(d); bump();
    toast(`loaded pose "${name}"${d.clip && d.clip !== editState.clip ? ` (made for ${d.clip})` : ''}`);
  };
  const deletePose = (name: string) => setPosePresets((p) => { const n = { ...p }; delete n[name]; return n; });
  const quickSave = () => { if (!editState.active) return; savePose(poseName.trim() || saveAsName.trim() || editState.clip || 'pose'); };

  const downloadEditedX = () => {
    const eng = engineRef.current; if (!eng) return;
    const baked = eng.bakeEdits(saveAsName.trim() || undefined);
    if (!baked) { toast('nothing to save'); return; }
    const a = document.createElement('a');
    const url = URL.createObjectURL(new Blob([baked.text], { type: 'application/octet-stream' }));
    a.href = url; a.download = baked.name + '.x'; document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    toast(`saved ${baked.name}.x (${baked.bones} bone${baked.bones === 1 ? '' : 's'})`);
  };
  const downloadAllEdited = async () => {
    const eng = engineRef.current; if (!eng) return;
    toast('baking all edited clips...');
    const { files, errors } = await eng.bakeAll(clips, '_Edited');
    const usable = files.filter((f) => f.bones > 0);
    if (!usable.length) { toast('nothing to bulk-export' + (errors.length ? ': ' + errors[0] : ' (no edited clips)')); return; }
    const zip = makeZip(usable.map((f) => ({ name: f.name + '.x', bytes: new TextEncoder().encode(f.text) })));
    const a = document.createElement('a');
    const url = URL.createObjectURL(new Blob([zip as BlobPart], { type: 'application/zip' }));
    a.href = url; a.download = 'edited-anims.zip'; document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    toast(`exported ${usable.length} clip${usable.length === 1 ? '' : 's'} to edited-anims.zip${errors.length ? ` (${errors.length} skipped)` : ''}`);
  };
  const saveToFolder = async () => {
    const eng = engineRef.current; const b = nativeBridge();
    if (!eng || !b?.writeFile) { toast('folder save is desktop-only'); return; }
    const baked = eng.bakeEdits(saveAsName.trim() || undefined);
    if (!baked) { toast('nothing to save'); return; }
    const dir = await b.pickDirectory('anim-save'); if (!dir) return;
    try { const path = await b.writeFile(dir.replace(/[\\/]$/, '') + '/' + baked.name + '.x', new TextEncoder().encode(baked.text)); toast(`saved to ${path}`); }
    catch (e) { toast('save failed: ' + (e instanceof Error ? e.message : String(e))); }
  };

  return { posePresets, poseName, setPoseName, posesOpen, setPosesOpen, collapsed, setCollapsed, savePose, loadPose, deletePose, quickSave, downloadEditedX, downloadAllEdited, saveToFolder };
}

export type PoseEditor = ReturnType<typeof usePoseEditor>;
