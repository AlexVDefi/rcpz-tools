// Shared glb optimizer for the bake pipeline.
//
//   1. stripExternalRefs - drop the dangling external material/texture/image refs assimp
//      emits (they point at textures we ship separately). Safe: the app assigns its own
//      ShaderMaterial to every loaded mesh and never reads the glb's material. Also unblocks
//      the gltf-transform reader.
//   2. dedup + prune + resample - lossless: merge duplicate accessors, drop unused data, and
//      remove redundant animation keyframes.
//   3. EXT_meshopt_compression with the FILTER method - and crucially NOT quantize().
//      This app does its own character rig retargeting that reads the RAW inverse-bind
//      matrices and bone rotations (see render/anim.js bindWorldFromSkin), so quantization -
//      which rescales geometry into a quantization volume and folds the factor into the skin
//      IBMs - corrupts the bind pose and mis-orients everything. The FILTER method keeps the
//      IBM values intact (verified byte-for-byte) while still compressing ~60%, and its output
//      supercompresses (gzip/brotli) better than QUANTIZE would.
//
// The browser decodes these with MeshoptDecoder; a fallback that only strips is a valid plain
// glb that loads without it.

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression } from '@gltf-transform/extensions';
import { dedup, prune, resample } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';

const GLB_MAGIC = 0x46546c67, JSON_TYPE = 0x4e4f534a, BIN_TYPE = 0x004e4942;

/** Remove materials/textures/images/samplers and primitive material refs from a glb. */
export function stripExternalRefs(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer || bytes, bytes.byteOffset || 0, bytes.byteLength);
  const total = buf.readUInt32LE(8);
  let off = 12, json = null, bin = null;
  while (off < total) {
    const clen = buf.readUInt32LE(off), ctype = buf.readUInt32LE(off + 4);
    const data = buf.subarray(off + 8, off + 8 + clen);
    if (ctype === JSON_TYPE) json = JSON.parse(data.toString('utf8'));
    else if (ctype === BIN_TYPE) bin = Buffer.from(data);
    off += 8 + clen;
  }
  delete json.materials; delete json.textures; delete json.images; delete json.samplers;
  for (const m of json.meshes || []) for (const p of m.primitives || []) delete p.material;
  let jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
  while (jsonBuf.length % 4) jsonBuf = Buffer.concat([jsonBuf, Buffer.from(' ')]);
  let binBuf = bin || Buffer.alloc(0);
  if (binBuf.length % 4) binBuf = Buffer.concat([binBuf, Buffer.alloc(4 - (binBuf.length % 4))]);
  const size = 12 + 8 + jsonBuf.length + (binBuf.length ? 8 + binBuf.length : 0);
  const out = Buffer.alloc(size);
  out.writeUInt32LE(GLB_MAGIC, 0); out.writeUInt32LE(2, 4); out.writeUInt32LE(size, 8);
  let o = 12;
  out.writeUInt32LE(jsonBuf.length, o); out.writeUInt32LE(JSON_TYPE, o + 4); jsonBuf.copy(out, o + 8); o += 8 + jsonBuf.length;
  if (binBuf.length) { out.writeUInt32LE(binBuf.length, o); out.writeUInt32LE(BIN_TYPE, o + 4); binBuf.copy(out, o + 8); }
  return new Uint8Array(out);
}

let _io = null;
async function getIO() {
  if (_io) return _io;
  await MeshoptEncoder.ready;
  _io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });
  return _io;
}

/**
 * Strip + resample + meshopt-compress one glb. Falls back to strip-only on any transform
 * failure so the output is always a valid, loadable glb.
 * @returns {Promise<{ bytes: Uint8Array, compressed: boolean }>}
 */
export async function optimizeGlb(glbBytes) {
  const stripped = stripExternalRefs(glbBytes);
  try {
    const io = await getIO();
    const doc = await io.readBinary(stripped);
    await doc.transform(dedup(), prune(), resample());
    doc.createExtension(EXTMeshoptCompression).setRequired(true)
      .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.FILTER });
    return { bytes: await io.writeBinary(doc), compressed: true };
  } catch {
    return { bytes: stripped, compressed: false };
  }
}
