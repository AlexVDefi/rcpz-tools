// Curated vanilla-tile library for the scene builder. Reads the PZ tile packs through the resolver
// (local game files today; a baked curated bundle later), indexes them WITHOUT loading the 1.4GB
// Tiles2x.pack whole (shared/pack.js indexPack + the source's readRange), and hands the browser/
// placement code classified tiles with lazy thumbnails and full-canvas placement sprites.
import * as THREE from 'three';
import { indexPack } from '@shared/pack.js';
import { buildTileCatalogue } from '@shared/tiles.js';
import { parseTileDefs, mergeTileDefs } from '@shared/tiledef.js';

export type TileCategory = 'floor' | 'overlay' | 'wall' | 'furniture' | 'vegetation' | 'other';
const CATEGORIES: TileCategory[] = ['floor', 'overlay', 'wall', 'furniture', 'vegetation', 'other'];
export interface TileInfo {
  name: string; sheet: string; index: number; pack: string; page: number;
  rect: { x: number; y: number; w: number; h: number };
  offset: { x: number; y: number }; full: { w: number; h: number };
  category: TileCategory; props: Record<string, string> | null;
}

// The starter set: whole sheets (so we get colour variants + wall orientations), grouped for the UI.
const CURATED: Record<TileCategory, string[]> = {
  floor: ['floors_exterior_natural_01', 'floors_exterior_street_01', 'floors_exterior_tilesandstone_01', 'floors_interior_carpet_01', 'floors_interior_tilesandwood_01'],
  overlay: ['floors_rugs_01', 'floors_rugs_02', 'rugs_animals'],
  wall: ['walls_exterior_house_01', 'walls_exterior_house_02', 'walls_interior_house_01', 'walls_interior_house_02'],
  furniture: ['furniture_tables_high_01', 'furniture_tables_low_01', 'furniture_seating_indoor_01', 'furniture_seating_indoor_02', 'furniture_bedding_01', 'furniture_storage_01', 'furniture_shelving_01', 'appliances_cooking_01', 'appliances_refrigeration_01', 'lighting_indoor_01'],
  vegetation: [],
  other: [],
};
const CURATED_SHEETS = new Set(Object.values(CURATED).flat());

const PACKS = ['media/texturepacks/Tiles2x.pack', 'media/texturepacks/Tiles2x.floor.pack'];
const TILEDEFS = ['media/newtiledefinitions.tiles', 'media/tiledefinitions_overlays.tiles', 'media/tiledefinitions_erosion.tiles'];

type Src = { readBytes(p: string): Promise<Uint8Array>; readRange?(p: string, o: number, l: number): Promise<Uint8Array>; stat(p: string): Promise<{ size: number } | null> };
type Resolver = { resolveMediaPath(p: string): Promise<{ src: Src; realPath: string } | null> };

interface PackRef { id: string; src: Src; realPath: string; pages: Array<{ entries: Array<{ name: string }>; pngOffset: number; pngSize: number }> }

export class TileLibrary {
  private resolver: Resolver;
  private tiles = new Map<string, TileInfo>();
  private packs = new Map<string, PackRef>();   // pack id -> ref (for lazy page loads)
  private pageImg = new Map<string, Promise<HTMLImageElement>>(); // `${packId}:${page}` -> decoded page
  private thumbs = new Map<string, string>();
  private loading: Promise<void> | null = null;

  constructor(resolver: Resolver) { this.resolver = resolver; }

  ensure(): Promise<void> { return (this.loading ??= this.load()); }
  private async load() {
    // index each pack via byte-range reads (never loads a whole pack)
    const packRefs: Array<{ id: string; pages: PackRef['pages'] }> = [];
    for (const path of PACKS) {
      const hit = await this.resolver.resolveMediaPath(path);
      if (!hit || !hit.src.readRange) continue;
      const size = (await hit.src.stat(hit.realPath))?.size ?? 0;
      const readRange = (o: number, l: number) => hit.src.readRange!(hit.realPath, o, l);
      const { pages } = await indexPack(readRange, size);
      const id = path.split('/').pop()!.replace(/\.pack$/i, '');
      this.packs.set(id, { id, src: hit.src, realPath: hit.realPath, pages });
      packRefs.push({ id, pages });
    }
    // tiledefs (optional per file)
    const tdMaps = [];
    for (const p of TILEDEFS) {
      const hit = await this.resolver.resolveMediaPath(p);
      if (hit) { try { tdMaps.push(parseTileDefs(await hit.src.readBytes(hit.realPath))); } catch { /* skip */ } }
    }
    const tiledefs = mergeTileDefs(tdMaps);
    // catalogue, filtered to the curated sheets, re-classified into the sheet's curated category
    const catalogue = buildTileCatalogue(packRefs, tiledefs);
    const sheetCategory = new Map<string, TileCategory>();
    for (const [c, sheets] of Object.entries(CURATED)) for (const s of sheets) sheetCategory.set(s, c as TileCategory);
    for (const t of catalogue.values()) {
      if (!CURATED_SHEETS.has(t.sheet)) continue;
      this.tiles.set(t.name, { ...(t as TileInfo), category: sheetCategory.get(t.sheet) ?? t.category });
    }
  }

  /** Curated tiles for a category, in sheet then index order. */
  list(category?: TileCategory): TileInfo[] {
    const arr = [...this.tiles.values()];
    const filtered = category ? arr.filter((t) => t.category === category) : arr;
    return filtered.sort((a, b) => a.sheet.localeCompare(b.sheet) || a.index - b.index);
  }
  categories(): TileCategory[] { return CATEGORIES.filter((c) => this.list(c).length > 0); }
  get(name: string): TileInfo | undefined { return this.tiles.get(name); }

  private page(packId: string, page: number): Promise<HTMLImageElement> {
    const key = `${packId}:${page}`;
    let p = this.pageImg.get(key);
    if (!p) {
      p = (async () => {
        const ref = this.packs.get(packId)!;
        const meta = ref.pages[page];
        const bytes = await ref.src.readRange!(ref.realPath, meta.pngOffset, meta.pngSize);
        return bytesToImage(bytes);
      })();
      this.pageImg.set(key, p);
    }
    return p;
  }

  /** Small thumbnail (the trimmed sprite crop) as a data URL, cached. */
  async thumbUrl(name: string): Promise<string> {
    const cached = this.thumbs.get(name); if (cached) return cached;
    const t = this.tiles.get(name); if (!t) return '';
    const img = await this.page(t.pack, t.page);
    const c = document.createElement('canvas'); c.width = t.rect.w; c.height = t.rect.h;
    const ctx = c.getContext('2d')!; ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, t.rect.x, t.rect.y, t.rect.w, t.rect.h, 0, 0, t.rect.w, t.rect.h);
    const url = c.toDataURL('image/png');
    this.thumbs.set(name, url);
    return url;
  }

  /** A de-sheared THREE texture for laying a FLAT tile (floor/rug) on the ground: the 2:1 iso diamond
   *  crop is un-squashed + rotated 45 back to an axis-aligned square (same trick as FloorLibrary), so
   *  a PlaneGeometry(TILE,TILE) shows the tile correctly at any camera angle. Cached per name. */
  private texCache = new Map<string, THREE.Texture>();
  async flatTexture(name: string): Promise<THREE.Texture | null> {
    const hit = this.texCache.get(name); if (hit) return hit;
    const t = this.tiles.get(name); if (!t) return null;
    const img = await this.page(t.pack, t.page);
    const S = 256, { w, h } = t.rect;
    const c = document.createElement('canvas'); c.width = S; c.height = S;
    const ctx = c.getContext('2d')!; ctx.imageSmoothingEnabled = false;
    const fill = ((S + 4) * Math.SQRT2) / w; // overscan closes sub-pixel seams between repeated tiles
    // rotate -45 (not +45): both axis-align the diamond but differ by 90 - this one keeps the tile's
    // pattern in the same orientation as the game/thumbnail once the iso camera re-shears it.
    ctx.translate(S / 2, S / 2); ctx.scale(fill, fill); ctx.rotate(-Math.PI / 4); ctx.scale(1, w / h);
    ctx.drawImage(img, t.rect.x, t.rect.y, w, h, -w / 2, -h / 2, w, h);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.NoColorSpace; tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false; tex.needsUpdate = true;
    this.texCache.set(name, tex);
    return tex;
  }

  /** The FULL sprite canvas (fx x fy) with the trimmed crop composited at its offset - this is the
   *  authored sprite the placement renderer anchors bottom-center onto a grid square. */
  async spriteCanvas(name: string): Promise<HTMLCanvasElement | null> {
    const t = this.tiles.get(name); if (!t) return null;
    const img = await this.page(t.pack, t.page);
    const c = document.createElement('canvas'); c.width = t.full.w; c.height = t.full.h;
    const ctx = c.getContext('2d')!; ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, t.rect.x, t.rect.y, t.rect.w, t.rect.h, t.offset.x, t.offset.y, t.rect.w, t.rect.h);
    return c;
  }
}

async function bytesToImage(bytes: Uint8Array): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: 'image/png' }));
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
  URL.revokeObjectURL(url);
  return img;
}
