// Floor tiles from PZ's Tiles2x.floor.pack (2x res = sharp), for scene backgrounds. PZ floor
// sprites are 2:1 iso DIAMONDS (~126x64), pre-sheared for the game's iso view, so to lay one
// on a flat 3D floor we de-shear it back to an axis-aligned square (un-squash Y, rotate 45,
// scale to fill) and repeat it. The 2x pack is ~44MB across 11 atlas pages, so pages are
// decoded LAZILY — only when a tile from that page is first rendered — and cached.
import * as THREE from 'three';
import { parsePack } from '@shared/pack.js';

const PACK_PATH = 'media/texturepacks/tiles2x.floor.pack';
const FLOOR_PREFIX = /^(floors_|blends_)/;
const TEX_SIZE = 256;   // de-sheared texture (crisp)
const THUMB_SIZE = 112; // grid thumbnail

export interface FloorTile { name: string; x: number; y: number; w: number; h: number }
interface Rec { tile: FloorTile; page: number }
interface Page { png: Uint8Array; image: HTMLImageElement | null; decoding: Promise<HTMLImageElement> | null }

export class FloorLibrary {
  private resolver: { resolveMediaPath(p: string): Promise<{ src: { readBytes(p: string): Promise<Uint8Array> }; realPath: string } | null> };
  private pages: Page[] = [];
  private recs = new Map<string, Rec>();
  private texCache = new Map<string, THREE.Texture>();
  private thumbCache = new Map<string, string>();
  private loading: Promise<void> | null = null;

  constructor(resolver: FloorLibrary['resolver']) { this.resolver = resolver; }

  ensure(): Promise<void> { return this.loading ??= this.load(); }
  private async load() {
    const hit = await this.resolver.resolveMediaPath(PACK_PATH);
    if (!hit) throw new Error('floor pack not found (' + PACK_PATH + ')');
    const { pages } = parsePack(await hit.src.readBytes(hit.realPath)) as { pages: Array<{ png: Uint8Array; entries: FloorTile[] }> };
    this.pages = pages.map((p) => ({ png: p.png, image: null, decoding: null }));
    pages.forEach((p, pi) => p.entries.forEach((e) => {
      if (FLOOR_PREFIX.test(e.name) && !this.recs.has(e.name)) this.recs.set(e.name, { tile: e, page: pi });
    }));
  }

  async list(): Promise<FloorTile[]> { await this.ensure(); return [...this.recs.values()].map((r) => r.tile); }

  private pageImage(pi: number): Promise<HTMLImageElement> {
    const p = this.pages[pi];
    if (p.image) return Promise.resolve(p.image);
    return p.decoding ??= bytesToImage(p.png).then((img) => { p.image = img; return img; });
  }

  private deshear(atlas: HTMLImageElement, e: FloorTile, T: number): HTMLCanvasElement {
    const c = document.createElement('canvas'); c.width = T; c.height = T;
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    const { w, h } = e;
    const fill = (T * Math.SQRT2) / w; // de-sheared square side = w/√2 -> scale to fill T
    ctx.translate(T / 2, T / 2);
    ctx.scale(fill, fill);
    ctx.rotate(Math.PI / 4);
    ctx.scale(1, w / h); // undo the 2:1 iso vertical squash
    ctx.drawImage(atlas, e.x, e.y, w, h, -w / 2, -h / 2, w, h);
    return c;
  }

  async texture(name: string): Promise<THREE.Texture | null> {
    await this.ensure();
    const cached = this.texCache.get(name); if (cached) return cached;
    const rec = this.recs.get(name); if (!rec) return null;
    const tex = new THREE.CanvasTexture(this.deshear(await this.pageImage(rec.page), rec.tile, TEX_SIZE));
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.NoColorSpace;
    tex.anisotropy = 8;
    tex.needsUpdate = true;
    this.texCache.set(name, tex);
    return tex;
  }

  async thumbUrl(name: string): Promise<string> {
    await this.ensure();
    const cached = this.thumbCache.get(name); if (cached) return cached;
    const rec = this.recs.get(name); if (!rec) return '';
    const url = this.deshear(await this.pageImage(rec.page), rec.tile, THUMB_SIZE).toDataURL('image/png');
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
