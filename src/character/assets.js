'use strict';

// Character asset resolution (main process). Turns a character description
// (gender, skin tone, clip choice) into concrete, loadable file paths, using the
// same VFS + assimp conversion the icon path uses. The renderer only ever sees
// glb/png files, never raw .x/.fbx.

const { resolveMesh, resolveTexture, listAnims } = require('../vfs');
const { ensureGlb } = require('../convert');

// Skin tones are a plain texture pick, five per gender. The male 'a' variants add
// body hair; expose them as extra tones rather than a separate toggle.
const SKIN_TONES = {
  male: ['MaleBody01', 'MaleBody02', 'MaleBody03', 'MaleBody04', 'MaleBody05',
         'MaleBody01a', 'MaleBody02a', 'MaleBody03a', 'MaleBody04a', 'MaleBody05a'],
  female: ['FemaleBody01', 'FemaleBody02', 'FemaleBody03', 'FemaleBody04', 'FemaleBody05'],
};

const BODY_MESH = { male: 'Skinned/MaleBody', female: 'Skinned/FemaleBody' };

/** Resolve + convert the body mesh and pick a skin texture. Returns loadable paths. */
function resolveBody(vfs, { gender = 'male', skin } = {}) {
  const g = gender === 'female' ? 'female' : 'male';
  const meshName = BODY_MESH[g];
  const mesh = resolveMesh(vfs, meshName);
  if (!mesh || mesh.unsupported) throw new Error(`body mesh not found: ${meshName} (is the game folder set?)`);
  const glb = ensureGlb(mesh.file, mesh.format);

  const tones = SKIN_TONES[g];
  const chosen = tones.includes(skin) ? skin : tones[0];
  const skinTexture = resolveTexture(vfs, `Body/${chosen}`);
  if (!skinTexture) throw new Error(`skin texture not found: Body/${chosen}.png`);

  return { gender: g, skin: chosen, tones, meshFile: glb.file, meshFormat: glb.format, skinTexture };
}

/**
 * The clip library for the animation browser, mod clips marked and sorted first.
 * Returns light metadata only (no conversion) so listing 2209 clips stays instant.
 */
// Only these actors use the human Bip01 skeleton and retarget to the player body;
// animal clips (Cow, Deer, Chicken, ...) have their own skeletons and would just
// render as the static bind pose, so they are never loaded.
const HUMAN_ACTORS = new Set(['bob', 'kate', 'zombie']);

function listClips(vfs, modRootDirs = []) {
  const clips = listAnims(vfs, modRootDirs)
    .filter((a) => HUMAN_ACTORS.has(String(a.actor).toLowerCase()))
    .map((a) => ({
      id: a.key, name: a.clip, actor: a.actor, format: a.format,
      isMod: a.isMod, file: a.file,
      // FBX clips are best-effort (authored in a different root frame); flag them
      best: a.format === 'x' || a.format === 'glb' || a.format === 'gltf',
    }));
  clips.sort((a, b) =>
    (b.isMod - a.isMod) ||
    a.actor.localeCompare(b.actor) ||
    a.name.localeCompare(b.name));
  return clips;
}

/** Convert one chosen clip to glb on demand (cached). Returns a loadable path. */
function resolveClip(clip) {
  const glb = ensureGlb(clip.file, clip.format);
  return { ...clip, glbFile: glb.file };
}

module.exports = { resolveBody, listClips, resolveClip, SKIN_TONES, BODY_MESH };
