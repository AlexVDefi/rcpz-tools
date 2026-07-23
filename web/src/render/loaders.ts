// Byte -> three loaders (browser). Replaces renderCore.js's file:// loaders.
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

// assimp's glb export references each material's ORIGINAL texture by bare filename
// (e.g. "MaleBody02a.png"). We never use those - every mesh's material is replaced with
// our own PZ-resolved texture right after load - but GLTFLoader.parse still tries to
// fetch each filename and 404s, spamming the console. Redirect any image request to a
// 1x1 transparent pixel so parsing stays silent and does no wasted network work.
const BLANK_PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const manager = new THREE.LoadingManager();
manager.setURLModifier((url) => (/\.(png|jpe?g|tga|bmp|dds|gif)$/i.test(url) ? BLANK_PX : url));
const gltfLoader = new GLTFLoader(manager);
// Hosted bundles ship EXT_meshopt_compression glbs; the decoder is only invoked when the
// extension is present, so uncompressed (local) glbs are unaffected.
gltfLoader.setMeshoptDecoder(MeshoptDecoder);

/** Parse self-contained glb bytes (from the WASM converter) into a GLTF result. */
export function glbToGltf(bytes: Uint8Array): Promise<GLTF> {
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new Promise((resolve, reject) => gltfLoader.parse(ab, '', resolve, reject));
}

// assimp appends pivot suffixes like `Name_$AssimpFbx$_Translation` to FBX object nodes; strip
// those (and whitespace) so a PZ sub-mesh name matches the loaded node.
const cleanName = (s: string) => s.replace(/_\$assimpfbx\$.*$/i, '').replace(/\s+/g, '').toLowerCase();

/**
 * PZ packs several parts in one model file and selects one via `mesh = file|SubMeshName`
 * (modular weapons). The converted glb still holds every part, so keep only the named object's
 * subtree (and the transform chain above it, so it stays positioned) and drop the other meshes.
 * No-op when `name` is empty or matches nothing (falls back to showing the whole file).
 */
export function isolateSubMesh(scene: THREE.Object3D, name?: string | null): void {
  if (!name) return;
  const target = cleanName(name);
  const matches: THREE.Object3D[] = [];
  scene.traverse((o) => { if (o !== scene && cleanName(o.name) === target) matches.push(o); });
  const node = matches[0];
  if (!node) return; // unknown name: better to show the whole file than nothing
  const keep = new Set<THREE.Object3D>();
  node.traverse((o) => keep.add(o));                             // the chosen part + its children
  for (let p: THREE.Object3D | null = node; p; p = p.parent) keep.add(p); // its ancestor transforms
  const drop: THREE.Object3D[] = [];
  scene.traverse((o) => { if ((o as THREE.Mesh).isMesh && !keep.has(o)) drop.push(o); });
  for (const o of drop) o.parent?.remove(o);
}

/**
 * PNG bytes -> texture. Uses HTMLImageElement + object URL (NOT ImageBitmap): three
 * honours texture.flipY for an <img> source but ignores it for ImageBitmap. The assimp
 * glb meshes carry glTF-convention UVs, so every asset (body, clothing, held items) loads
 * its texture with flipY=false; keep the <img> path so that stays correct.
 */
export function bytesToTexture(bytes: Uint8Array, flipY: boolean): Promise<THREE.Texture> {
  return new Promise((resolve, reject) => {
    const blob = new Blob([bytes as unknown as BlobPart], { type: 'image/png' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const tex = new THREE.Texture(img);
      tex.flipY = flipY;
      tex.colorSpace = THREE.NoColorSpace;
      tex.magFilter = THREE.NearestFilter;
      tex.minFilter = THREE.NearestFilter;
      tex.generateMipmaps = false;
      tex.needsUpdate = true;
      URL.revokeObjectURL(url);
      resolve(tex);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('texture decode failed')); };
    img.src = url;
  });
}

/** Texture from an already-decoded canvas/bitmap (the Canvas body compositor output). */
export function sourceToTexture(source: TexImageSource, flipY: boolean): THREE.Texture {
  const tex = new THREE.Texture(source as HTMLImageElement);
  tex.flipY = flipY;
  tex.colorSpace = THREE.NoColorSpace;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}
