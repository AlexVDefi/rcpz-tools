// Floor tiles from PZ's Tiles1x.floor.pack, for scene backgrounds. PZ floor sprites are
// 2:1 iso DIAMONDS (~63x32), pre-sheared for the game's isometric view, so to lay one on a
// flat 3D floor plane we de-shear it back into an axis-aligned square (un-squash Y, rotate
// 45, scale to fill) and repeat it. Vanilla floors only; a mod could override the pack via
// the resolver. Atlas decoded once; textures + thumbnails cached.
import * as THREE from 'three';
import { parsePack } from '@shared/pack.js';

const PACK_PATH = 'media/texturepacks/tiles1x.floor.pack';
const FLOOR_PREFIX = /^(floors_|blends_)/;

export interface FloorTile { name: string; x: number; y: number; w: number; h: number }

export class FloorLibrary {
  private resolver: { resolveMediaPath(p: string): Promise<{ src: { readBytes(p: string): Promise<Uint8Array> }; realPath: string } | null> };
  private atlas: HTMLImageElement | null = null;
  private entries = new Map<string, FloorTile>();
  private texCache = new Map<string, THREE.Texture>();
  private thumbCache = new Map<string, string>();
  private loading: Promise<void> | null = null;

  constructor(resolver: FloorLibrary['resolver']) { this.resolver = resolver; }

  ensure(): Promise<void> { return this.loading ??= this.load(); }
  private async load() {
    const hit = await this.resolver.resolveMediaPath(PACK_PATH);
    if (!hit) throw new Error('floor pack not found (' + PACK_PATH + ')');
    const { pages } = parsePack(await hit.src.readBytes(hit.realPath));
    for (const e of pages[0].entries) if (FLOOR_PREFIX.test(e.name)) this.entries.set(e.name, e);
    this.atlas = await bytesToImage(pages[0].png);
  }

  async list(): Promise<FloorTile[]> { await this.ensure(); return [...this.entries.values()]; }

  private deshear(e: FloorTile, T: number): HTMLCanvasElement {
    const c = document.createElement('canvas'); c.width = T; c.height = T;
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingEnabled = true;
    const { w, h } = e;
    const fill = (T * Math.SQRT2) / w; // de-sheared square side = w/√2 -> scale to T
    ctx.translate(T / 2, T / 2);
    ctx.scale(fill, fill);
    ctx.rotate(Math.PI / 4);
    ctx.scale(1, w / h); // undo the 2:1 iso vertical squash
    ctx.drawImage(this.atlas!, e.x, e.y, w, h, -w / 2, -h / 2, w, h);
    return c;
  }

  async texture(name: string): Promise<THREE.Texture | null> {
    await this.ensure();
    const cached = this.texCache.get(name); if (cached) return cached;
    const e = this.entries.get(name); if (!e) return null;
    const tex = new THREE.CanvasTexture(this.deshear(e, 128));
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.NoColorSpace;
    tex.anisotropy = 4;
    tex.needsUpdate = true;
    this.texCache.set(name, tex);
    return tex;
  }

  async thumbUrl(name: string): Promise<string> {
    await this.ensure();
    const cached = this.thumbCache.get(name); if (cached) return cached;
    const e = this.entries.get(name);
    const url = e ? this.deshear(e, 96).toDataURL('image/png') : '';
    this.thumbCache.set(name, url);
    return url;
  }
}

async function bytesToImage(bytes: Uint8Array): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: 'image/png' }));
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
  URL.revokeObjectURL(url);
  return img;
}
