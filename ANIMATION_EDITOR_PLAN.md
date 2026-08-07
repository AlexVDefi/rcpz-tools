# Survivor Studio Animation Editor - Implementation Plan

Branch: `feat/animation-editor`

Confirmed decisions:
- Architecture: text-surgery (port `x_edit.py` to TS); three.js is preview only.
- Save target: both - download in the browser build, write to a mod folder in
  Electron / local-game-files mode.

Goal: edit the pose of vanilla PZ animations inside Survivor Studio, author new
animations from edited vanilla ones (keyframes + interpolation), save them, and
bulk copy/paste per-bone adjustments across many clips with bulk export. In
short: everything pz-anim-forge's `.x` editor does, with far better UX and live
3D controls.

---

## 1. What exists today (verified)

### pz-anim-forge (the reference)
- Core engine is `pzanimforge/x_edit.py`: **pure text surgery** on the `.x`
  file. It regex-locates a bone's `AnimationKey R/S/T` body and splices new
  numbers in, leaving every other byte verbatim (CRLF preserved via
  `newline=""`, lone `;` lines left intact, other bones untouched). Lossless
  round-trip by construction. Has an offline `--selftest`.
- Data model is the `.x` text itself: `AnimationSet > per-bone AnimationKey`
  R (quaternion `w,x,y,z`), S (`x,y,z`), T (`x,y,z`), integer ticks at
  `AnimTicksPerSecond` (default 4800). Poses are sampled with shortest-arc
  slerp (R) / lerp (S,T).
- Edits: constant per-bone rotation delta (`apply_delta`), constant translation
  delta (`apply_translation_delta`), keyframed rotation/translation timelines
  (`apply_rot_timeline` / `apply_pos_timeline`, keys inserted only strictly
  inside the bone's existing `[lo,hi]` tick range, with the `nKeys` count
  rewritten), flatten-to-identity, freeze-to-frame0, despike, single-frame
  trim, rename AnimationSet.
- **Critical rotation convention** (`_transform_body`, verified in-game
  2026-07-27): because the game loads `.x` through jassimp with
  `MAKE_LEFT_HANDED` and assimp conjugates rotation keys on read, the net
  file->runtime map reverses composition order. So a local euler delta `dq`
  is applied as `conj(dq) . q` (post) or `q . conj(dq)` (pre), NOT `dq . q`.
  Porting this exactly is non-negotiable.
- Editor-save schema (`anim_edit.json`, consumed by `bake_deltas.py`):
  `{ clip, deltas:{bone:{rot:[x,y,z], pos:[x,y,z]}}, keyframes:{clip:{bone:[{t,rot,pos}]}}, clipLens, set|gunworks|emote }`.
  `deltas` is a set-wide flat map; `keyframes[clip]` overrides per clip. That
  flat-map-plus-per-clip-override IS anim-forge's "copy one grip across a whole
  set, refine individual clips" model.
- Bulk: `bake-set` applies the set-wide delta map across a clip family and
  writes renamed `.x` into a mod (never touches vanilla). Per-bone targeting is
  just the flat `deltas` map keyed by bone name.
- Skeleton: 46-bone Bip01 biped, bones addressed by exact name string
  (`config/skeleton_bones.txt`). Weapon sockets `Bip01_Prop1/Prop2`.

### Survivor Studio (the target)
- Animate tab: clip list is a filesystem walk of `media/anims_x/<actor>/*`
  (names only), rendered in a generic `<AssetGrid>` with search/facets. Source
  in `shared/asset-index.js:96`, `shared/character-core.js:listClips`.
- Load/play: `playClip` (`character-engine.ts:1847`) -> `resolveClip` bytes ->
  assimpjs WASM `convertToGlb(bytes,'glb2')` (`shared/mesh-converter.js`) ->
  `glbToGltf` -> `normaliseClip` (`anim.ts:200`) -> `RigSet.setClip`
  (per-rig `THREE.AnimationMixer` + `clipAction`).
- Transport: `seek(frac)`->`rigs.setTime`, `setLoop`, `setSpeed`, `replay`,
  `togglePlay`; `onFrame(t,dur)` drives the scrub slider. Pause = `playing=false`
  so the mixer holds the current pose; `seek` works while paused.
- Retarget: for `.x`/native-format clips `normaliseClip` is **passthrough**
  (no retarget); the world-space inverse-bind retarget (`retargetWorld`) is only
  used for foreign glb/gltf/fbx rigs. So a vanilla `.x` plays on the PZ body
  with its own bone-local rotations (subject to the assimpjs import convention).

### Two hard constraints
1. **No `.x` writer exists** and it is not a config flip: the vendored assimpjs
   WASM has no DirectX-X (or FBX) exporter, only assbin/collada/stl/obj/gltf/glb.
   The Electron native path also exports glb only.
2. **No per-bone pose override exists**: posing is entirely mixer-driven. A pose
   editor must add bone writes after `rigs.update` and manage the mixer conflict.

---

## 2. Architecture decision

**Adopt anim-forge's model: text surgery on the original `.x`, driven by
author-dialled per-bone deltas, with a live three.js preview.** Reject
re-serializing edited three.js tracks to `.x`.

Rationale:
- Reuses `x_edit.py`'s in-game-verified math and lossless round-trip. Output is
  byte-exact vanilla-loadable `.x`.
- Sidesteps both hard constraints cleanly: we never need assimpjs to export, and
  we never need to invert `retargetWorld`.
- The editor model (per-bone deltas + keyframes) is exactly what a good UI wants
  to expose, and it interops conceptually with `anim_edit.json`.

Consequence: the editor's authoritative output is produced by a **TypeScript port
of `x_edit.py`** (`web/src/anim-edit/xedit.ts`). The three.js side is preview +
UX only. Source clips must be `.x` for `.x` export (vanilla PZ anims are `.x`);
`.fbx`/`.glb`-sourced clips are out of scope for `.x` export in v1.

---

## 3. The one correctness risk: preview must equal bake

The author dials a delta in "local game euler degrees". The BAKE applies it to
the `.x` with the `conj(dq)` left-handed convention so it looks right IN GAME.
The PREVIEW applies it to the app's three.js skeleton, whose bone-local frame
came through assimpjs's import convention, which may differ from the game's
jassimp `MAKE_LEFT_HANDED`+conjugate. If the two conventions differ, a slider
that looks right in the preview will bake a `.x` that looks wrong in game.

This must be resolved empirically before any UI is built (Phase 0). Deliverable:
a single verified function pair `previewDelta(bone,euler)` (three.js) and
`bakeDelta(xText,bone,euler)` (text) that provably agree, established by:
1. Port `x_edit`'s quat helpers + `apply_delta`/`apply_translation_delta` to TS
   with the selftest translated to unit tests (locks the bake math immediately).
2. Take one vanilla clip, apply a large single-axis delta to one bone, bake `.x`,
   re-convert through assimpjs, and play it; compare to the same delta applied as
   a direct bone write. Derive the exact transform (identity, a conjugate, or a
   fixed basis change) between "app bone-local delta" and "anim-forge delta".
3. Confirm in-game via the AgentBridge test path (load the baked `.x`, screenshot)
   for at least one rotation and one translation on `Bip01_R_UpperArm`/`R_Hand`.

Everything else is gated on this.

---

## 4. Editor data model

Mirror `anim_edit.json` so the concept (and math) matches anim-forge and edits
are portable:

```
AnimEdit = {
  clip: string,                              // source clip id
  sourceName: string,                        // original AnimationSet name
  saveAs?: string,                           // new set name (new-animation path)
  deltas: { [bone]: { rot:[x,y,z]deg, pos:[x,y,z] } },      // constant offsets
  keyframes?: { [bone]: Array<{ t:number, rot:[x,y,z], pos:[x,y,z] }> }, // timeline (t in seconds)
  clipLenSec: number,
}
Clipboard = { bones: { [bone]: { rot, pos, keyframes? } } }  // per-bone copy/paste
Project   = { edits: { [clipId]: AnimEdit }, setDeltas: { [bone]: delta } }  // set-wide map + per-clip
```

Persist `Project` to `localStorage` (and export/import as JSON) so edits survive
reloads and can be re-baked, exactly like the anim-forge save file.

---

## 5. Phased implementation

### Phase 0 - Correctness spike (gate)  [DONE]
- `web/src/anim-edit/xedit.ts`: full port of `x_edit.py` (quat helpers,
  `eulerToQuat`, `applyDelta`, `applyTranslationDelta`, `applyRotTimeline`,
  `applyPosTimeline`, `renameSet`). Selftest ported to `xedit.selftest.mts`,
  PASS at err 1.2e-13. `xedit.cli.mts` is the bake CLI (also the Electron export
  path).
- Bake proven correct: baked `.x` is BYTE-IDENTICAL to the in-game-verified
  `x_edit.py` on a real 200KB vanilla clip (Bob_Idle) - rotation (21 keys),
  translation (2 keys), and surgical (only the target bone changes).
- Preview<->bake convention resolved and verified (`xedit.basis.mts`): the app's
  assimpjs importer applies a single GLOBAL basis change P = 180deg about Z
  (`ASSIMP_BASIS`) from PZ .x local space to glTF/three local space. A .x delta
  `d` renders in the app as `d_app = P d conj(P)`; verified at dot 1.0000 across
  R/L arms, spine and thigh for X/Y/Z and compound deltas.
- Editor round-trip (all verified): author poses a bone directly in app space
  (delta `A`, exact preview) -> bake `.x` with `d = conj(P) A P` (`appDeltaToX`)
  -> the .x reconverts back to exactly `A`, and is byte-identical to x_edit.py so
  it is correct in game.
- In-game run is now confirmatory only (byte-identity to the in-game-verified
  tool already guarantees the result); do it opportunistically when a game is up.

### Phase 1 - Edit-mode foundation  [DONE]
Raw .x retained on load; an "edit" toggle on the transport bar (only for .x clips)
pauses playback, shows pickable joint spheres, and opens a bone editor panel. Bone
selection via joint raycast or a searchable list. Per-bone override applied after
the mixer as base*appDelta, re-based off the fresh clip pose on seek/play so it
never compounds. Manipulation via rotation + offset sliders (a 3D bone gizmo is a
later upgrade). Body rig only for now (clothing sync is a refinement).

### Phase 2 - Constant pose editing + save  [DONE]
Position calibration verified globally (assimpjs flips Z, no scale; `appPosToX`).
`bakeEdits(saveAs?)` converts each bone's app-space delta to .x via `appDeltaToX`
(rotation) / `appPosToX` (translation) and splices with `applyDelta` /
`applyTranslationDelta`; `renameSet` (sanitised) makes a non-clobbering variant.
Save UI: a save-as name + Download .x (browser + desktop) and, on desktop, Save
to folder (new read/write `pzDesktop.writeFile`). Bake correctness follows from
the Phase 0 proofs (byte-identical applyDelta + arbitrary-delta basis verify).

### Phase 1 detail (superseded by the DONE note above)
- Retain the original `.x` text on load: extend `resolveClip`/`playClip` to keep
  raw source bytes for the current clip (only when format is `.x`).
- "Enable editing" affordance on the Animate tab for the loaded clip -> enters
  edit mode: pause playback, show joint pickers, open the editor panel.
- Bone selection: render small pickable joint spheres at bone world positions
  (reuse the raycast/selection/outline patterns already built for props); plus a
  searchable bone list. Single + multi-select (shift / the mobile select-mode
  already built).
- Post-mixer bone override: between `rigs.update` and `drawFrame`
  (`character-engine.ts:176-184`) write selected/edited bones from the delta
  model each frame; keep playback paused in edit mode to avoid mixer fighting.

### Phase 2 - Constant pose editing (per bone)
- Transform a selected bone via a gizmo and/or the existing modal G/R/S
  (repurpose the prop transform infra for bones), producing a per-bone constant
  `rot`/`pos` delta stored in `AnimEdit.deltas`.
- Live preview through the Phase-0 transform; on-screen readout of euler/pos.
- Save: `bakeConstant` -> edited `.x`; download (web) or write to a chosen mod
  folder (Electron/local-files mode). "Save as" sets `saveAs` and renames the
  AnimationSet so vanilla is never clobbered (new-animation path).

### Phase 3 - Keyframes + interpolation (timeline)
- Port `apply_rot_timeline`/`apply_pos_timeline` + `_timeline_block`
  (insert-within-range, `nKeys` rewrite, slerp/lerp sampling) to `xedit.ts`.
- Dopesheet/timeline UI under the scrub bar: per selected bone, a track of
  keyframes; scrub to a time, adjust the bone, add/move/delete a key; keys
  interpolate (slerp R, lerp T). Preview samples the delta timeline at the
  current time. Store in `AnimEdit.keyframes`.
- Respect anim-forge's constraint (keys only inside the clip's existing range)
  in v1; clip-length change is a Phase 5 stretch.

### Phase 4 - Bulk copy/paste + bulk export
- Per-bone clipboard: copy selected bones' deltas/keyframes; paste onto other
  selected bones (with optional L<->R name remap) and/or onto other clips.
- Set-wide deltas: promote an edit to the `Project.setDeltas` map so it applies
  across a chosen clip family; per-clip `keyframes` still override.
- Multi-clip select in the Animate grid -> bulk bake all -> download a zip of
  edited `.x` (bake-set model), each with a `saveAs` set name. JSZip or a small
  zip writer; edits sourced from the persisted `Project`.
- Import/export the `Project` JSON (interop with anim-forge saves where shapes
  align).

### Phase 5 - Authoring polish (stretch, "make animations easily")
- Clip-length extension / retiming / keys outside the original range (beyond
  anim-forge), easing per key, L/R mirror, onion-skinning, copy a pose between
  times, snap-to-frame. Prioritize after 0-4 land.

---

## 6. UX / UI design targets
- Animate tab: a clear "Edit this animation" toggle on the selected clip; edit
  mode shows joints + a right-side editor panel (bone list, transform readouts,
  keyframe track), reusing the Scene/Prop popover styling and the mobile bars.
- Direct 3D bone manipulation with the gizmo and modal G/R/S already built for
  props (desktop) plus the touch gesture model just shipped (mobile).
- A dopesheet timeline aligned to the existing scrub bar.
- A visible, honest diff: which bones are edited, quick per-bone reset, and a
  clear "new name" field for saving a variant.
- Non-destructive: vanilla is never overwritten; output is a download or a mod
  folder write, always under a new set name unless the user explicitly opts in.

## 7. Risks / mitigations
- Preview!=bake convention (Phase 0 gate) - highest risk; resolve empirically
  first, lock with unit tests + one in-game verification.
- assimpjs import convention drift across versions - pin assimpjs; the bake path
  does not depend on it (text surgery), only the preview does.
- Perf: re-converting `.x` on every drag is too slow; preview via direct bone
  writes (fast), bake only on save. Optionally a debounced "verify" re-bake.
- `.fbx`/`.glb`-sourced clips can't export `.x` (no writer) - scope v1 to
  `.x`-sourced clips; surface a clear "not exportable to .x" state for others.
- Web can't write files - export via download / zip; Electron/local-files mode
  may write directly to a mod's `media/anims_X/<actor>/`.

## 8. Out of scope (v1)
- Exporting non-`.x` sources back to `.x`.
- Recompiling assimpjs with an X exporter (kept as a fallback option only).
- Full from-empty animation authoring (v1 is edit-vanilla-to-variant; from
  scratch is a Phase 5 extension).
