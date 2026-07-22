// Decide the lossless compression strategy: for a mesh and a clip, produce several variants
// and print each one's IBM[0] (must match RAW to preserve the app's rig retarget) and size.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNodeAssetSource } from '../shared/asset-source.js';
import { createResolver } from '../shared/path-resolve.js';
import { createMeshConverter } from '../shared/mesh-converter.js';
import { stripExternalRefs } from './glb-optimize.mjs';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression } from '@gltf-transform/extensions';
import { dedup, prune, resample, meshopt } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const kb = (n) => (n / 1024).toFixed(0) + 'KB';

async function main() {
  const install = arg('--install', 'D:/Games/Steam/steamapps/common/ProjectZomboid');
  const src = createNodeAssetSource(install, { id: 'pz' });
  const resolver = createResolver([src]);
  const converter = createMeshConverter();
  await MeshoptDecoder.ready; await MeshoptEncoder.ready;

  const io = () => new NodeIO().registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });

  async function rawGlbOf(meshName) {
    const hit = await resolver.resolveMesh(meshName);
    return { glb: await converter.convertToGlb(await src.readBytes(hit.realPath), hit.format) };
  }
  const ibm0 = async (bytes) => {
    const doc = await io().readBinary(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    const skin = doc.getRoot().listSkins()[0];
    if (!skin) return 'no-skin';
    return [...skin.getInverseBindMatrices().getArray().slice(0, 6)].map((n) => n.toFixed(3)).join(',');
  };

  const variants = {
    'strip only': async (glb) => stripExternalRefs(glb),
    'strip+dedup+prune+resample': async (glb) => {
      const doc = await io().readBinary(stripExternalRefs(glb));
      await doc.transform(dedup(), prune(), resample());
      return await io().writeBinary(doc);
    },
    'above + meshopt FILTER (no quantize)': async (glb) => {
      const doc = await io().readBinary(stripExternalRefs(glb));
      await doc.transform(dedup(), prune(), resample());
      doc.createExtension(EXTMeshoptCompression).setRequired(true)
        .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.FILTER });
      return await io().writeBinary(doc);
    },
    'meshopt() QUANTIZE (current/broken)': async (glb) => {
      const doc = await io().readBinary(stripExternalRefs(glb));
      await doc.transform(dedup(), prune(), resample(), meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
      return await io().writeBinary(doc);
    },
  };

  for (const meshName of ['Skinned/MaleBody']) {
    const { glb } = await rawGlbOf(meshName);
    const raw = stripExternalRefs(glb);
    const rawIbm = await ibm0(raw);
    console.log(`\n### ${meshName}  (raw ${kb(raw.length)}, IBM0 ${rawIbm})`);
    for (const [name, fn] of Object.entries(variants)) {
      try {
        const out = await fn(glb);
        const ib = await ibm0(out);
        const match = ib === rawIbm ? 'IBM MATCH' : 'IBM CHANGED';
        console.log(`  ${name.padEnd(38)} ${kb(out.length).padStart(7)}   ${match}`);
      } catch (e) { console.log(`  ${name.padEnd(38)} ERROR ${e.message}`); }
    }
  }
}
main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
