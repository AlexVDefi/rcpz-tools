// Proves async case-insensitive, layered resolution over a real PZ install (R2).
import { createNodeAssetSource } from './asset-source.js';
import { createResolver } from './path-resolve.js';

const PZ = process.env.PZ_DIR || 'D:/Games/Steam/steamapps/common/ProjectZomboid';
const r = createResolver([createNodeAssetSource(PZ, { id: 'install' })]);

let fail = 0;
const check = (label, cond, detail) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}  ${detail || ''}`); if (!cond) fail++; };

// mesh resolution with varied casing (the input the scripts give is arbitrary-cased)
for (const name of ['Skinned/MaleBody', 'skinned/malebody', 'SKINNED/MALEBODY', 'Skinned/FemaleBody.X']) {
  const m = await r.resolveMesh(name);
  check(`resolveMesh("${name}")`, !!m && !m.unsupported, m ? `-> ${m.realPath} (${m.format})` : 'NOT FOUND');
}
// texture + media-path (masks)
const tex = await r.resolveMediaPath('media/textures/body/masks/HEAD.png');
check('resolveMediaPath mask (mixed case)', !!tex, tex ? `-> ${tex.realPath}` : 'NOT FOUND');

// a bogus path must NOT resolve
const none = await r.resolveMesh('skinned/definitely_not_a_mesh_xyz');
check('bogus mesh -> null', none === null);

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
