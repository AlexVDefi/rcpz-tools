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

  /** De-shear a tile into ctx, filling an S×S region (mirrored X for scene handedness). */
  private deshearInto(ctx: CanvasRenderingContext2D, atlas: HTMLImageElement, e: FloorTile, S: number) {
    ctx.save();
    ctx.imageSmoothingEnabled = false; // keep the grass pixels crisp, like the game (no bilinear blur)
    const { w, h } = e;
    // overscan ~2px each side so the rotated square bleeds past the edges (closes the sub-pixel
    // transparent slivers that show as thin black gaps between tiles when repeated)
    const fill = ((S + 4) * Math.SQRT2) / w;
    ctx.translate(S / 2, S / 2);
    ctx.scale(-fill, fill); // negative X mirrors horizontally to match the scene's handedness
    ctx.rotate(Math.PI / 4);
    ctx.scale(1, w / h); // undo the 2:1 iso vertical squash
    ctx.drawImage(atlas, e.x, e.y, w, h, -w / 2, -h / 2, w, h);
    ctx.restore();
  }
  private deshear(atlas: HTMLImageElement, e: FloorTile, T: number): HTMLCanvasElement {
    const c = document.createElement('canvas'); c.width = T; c.height = T;
    this.deshearInto(c.getContext('2d')!, atlas, e, T);
    return c;
  }

  async texture(name: string): Promise<THREE.Texture | null> {
    await this.ensure();
    const cached = this.texCache.get(name); if (cached) return cached;
    const rec = this.recs.get(name); if (!rec) return null;
    const tex = new THREE.CanvasTexture(this.deshear(await this.pageImage(rec.page), rec.tile, TEX_SIZE));
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.NoColorSpace;
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter; // crisp pixel grass like the game (no mipmap/bilinear blur)
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    this.texCache.set(name, tex);
    return tex;
  }

  /** Bake a varied floor texture: an N×N grid of random variants from `names`, de-sheared.
   *  Repeating this (vs one tile) gives the game's natural, non-repetitive look. Cached by key. */
  async presetTexture(names: string[], key: string, N = 8): Promise<THREE.Texture | null> {
    await this.ensure();
    const ck = 'preset:' + key;
    const cached = this.texCache.get(ck); if (cached) return cached;
    const recs = names.map((n) => this.recs.get(n)).filter(Boolean) as Rec[];
    if (!recs.length) return null;
    const T = 128, PAD = 22, F = T + 2 * PAD, W = N * T;
    const big = document.createElement('canvas'); big.width = W; big.height = W;
    const ctx = big.getContext('2d')!;
    let seed = 0; for (let i = 0; i < key.length; i++) seed = (seed * 31 + key.charCodeAt(i)) & 0x7fffffff;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const imgs = new Map<number, HTMLImageElement>();
    for (const r of recs) if (!imgs.has(r.page)) imgs.set(r.page, await this.pageImage(r.page));
    const img = (rec: Rec) => imgs.get(rec.page)!;
    const picks: Rec[] = [];
    for (let i = 0; i < N * N; i++) picks.push(recs[Math.floor(rnd() * recs.length)]);
    // Pass 1: opaque base, tiles edge-to-edge (hard seams) — guarantees full coverage.
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
      ctx.save(); ctx.translate(c * T, r * T); this.deshearInto(ctx, img(picks[r * N + c]), picks[r * N + c].tile, T); ctx.restore();
    }
    // Pass 2: blend ONLY the seam zone. A RING mask (transparent center + outer edge, opaque
    // annulus straddling the tile boundary) means pass-1's correct-scale centers show through,
    // while the overlapping oversized tiles cross-fade just at the seams. Edges wrap.
    const mask = document.createElement('canvas'); mask.width = F; mask.height = F;
    const mctx = mask.getContext('2d')!;
    const g = mctx.createRadialGradient(F / 2, F / 2, 0, F / 2, F / 2, F / 2);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.42, 'rgba(255,255,255,0)');
    g.addColorStop(0.62, 'rgba(255,255,255,0.85)');
    g.addColorStop(0.84, 'rgba(255,255,255,0.85)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    mctx.fillStyle = g; mctx.fillRect(0, 0, F, F);
    const cell = document.createElement('canvas'); cell.width = F; cell.height = F;
    const cctx = cell.getContext('2d')!;
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
      const rec = picks[r * N + c];
      cctx.clearRect(0, 0, F, F);
      this.deshearInto(cctx, img(rec), rec.tile, F);
      cctx.globalCompositeOperation = 'destination-in'; cctx.drawImage(mask, 0, 0); cctx.globalCompositeOperation = 'source-over';
      const x = c * T - PAD, y = r * T - PAD;
      for (const ox of [0, -W, W]) for (const oy of [0, -W, W]) ctx.drawImage(cell, x + ox, y + oy);
    }
    const tex = new THREE.CanvasTexture(big);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.NoColorSpace;
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter; // crisp pixel grass like the game (no mipmap/bilinear blur)
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    this.texCache.set(ck, tex);
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
