// Diagnostic: dump the node hierarchy + transforms of a raw-converted glb vs the optimized
// one, to find what the strip/resample/meshopt pass changed about orientation.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNodeAssetSource } from '../shared/asset-source.js';
import { createResolver } from '../shared/path-resolve.js';
import { createMeshConverter } from '../shared/mesh-converter.js';
import { stripExternalRefs, optimizeGlb } from './glb-optimize.mjs';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };

async function dump(io, bytes, label) {
  const doc = await io.readBinary(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  const root = doc.getRoot();
  const scene = root.listScenes()[0];
  const lines = [`--- ${label} : scenes=${root.listScenes().length} nodes=${root.listNodes().length} skins=${root.listSkins().length} anims=${root.listAnimations().length} ---`];
  const fx = (a) => '[' + a.map((n) => n.toFixed(3)).join(', ') + ']';
  const walk = (node, depth) => {
    if (depth > 2) return; // top of the tree is where orientation lives
    const tag = (node.getMesh() ? ' MESH' : '') + (node.getSkin() ? ' SKIN' : '');
    lines.push('  '.repeat(depth) + `"${node.getName()}"${tag} T=${fx(node.getTranslation())} R=${fx(node.getRotation())} S=${fx(node.getScale())}`);
    for (const c of node.listChildren()) walk(c, depth + 1);
  };
  for (const n of scene.listChildren()) walk(n, 0);
  // also the skin's first inverse-bind (orientation can hide here for skinned meshes)
  const skin = root.listSkins()[0];
  if (skin) { const ibm = skin.getInverseBindMatrices(); if (ibm) lines.push('  IBM[0] = ' + fx([...ibm.getArray().slice(0, 16)])); }
  return lines.join('\n');
}

async function main() {
  const install = arg('--install', 'D:/Games/Steam/steamapps/common/ProjectZomboid');
  const meshName = arg('--mesh', 'Skinned/MaleBody');
  const src = createNodeAssetSource(install, { id: 'pz' });
  const resolver = createResolver([src]);
  const hit = await resolver.resolveMesh(meshName);
  if (!hit) throw new Error(`mesh not resolved: ${meshName}`);
  const rawXbytes = await src.readBytes(hit.realPath);
  const converter = createMeshConverter();
  const rawGlb = await converter.convertToGlb(rawXbytes, hit.format);
  const { bytes: optGlb } = await optimizeGlb(rawGlb, { level: 'medium' });

  await MeshoptDecoder.ready; await MeshoptEncoder.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });

  console.log(await dump(io, stripExternalRefs(rawGlb), `RAW (strip only) ${meshName}`));
  console.log();
  console.log(await dump(io, optGlb, `OPTIMIZED (strip+meshopt) ${meshName}`));
}
main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
