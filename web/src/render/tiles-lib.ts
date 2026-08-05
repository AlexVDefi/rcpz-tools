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
// A browsable group: for walls, one material/colour (its N/W walls, corner, pillar, window + door frames);
// for everything else a single tile wrapped as a one-piece set, so the browser UI is uniform.
// A piece may span several cells (a 2-tile couch, a 2x2 bed): `tiles[0]` is the anchor (placed at the
// clicked cell), the rest carry world-cell offsets (dx,dy) so they drop alongside it. `tile` is the anchor
// (used for the thumbnail + as the selection key).
export interface TilePieceTile { tile: TileInfo; dx: number; dy: number; }
export interface TilePiece { label: string; tile: TileInfo; tiles: TilePieceTile[]; }
export interface TileSet { id: string; label: string; category: TileCategory; sheet: string; rep: TileInfo; defaultPiece: string; pieces: TilePiece[]; }
const one = (t: TileInfo): TilePieceTile[] => [{ tile: t, dx: 0, dy: 0 }];
// crop a canvas to the bounding box of its opaque pixels (so a composited multi-tile thumbnail is tight)
function trimCanvas(c: HTMLCanvasElement): HTMLCanvasElement {
  const ctx = c.getContext('2d')!; const { width: w, height: h } = c;
  if (!w || !h) return c;
  const d = ctx.getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { if (d[(y * w + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } }
  if (x1 < x0) return c;
  const tw = x1 - x0 + 1, th = y1 - y0 + 1;
  const out = document.createElement('canvas'); out.width = tw; out.height = th;
  out.getContext('2d')!.drawImage(c, x0, y0, tw, th, 0, 0, tw, th);
  return out;
}
const gridPos = (t: TileInfo) => { const [c, r] = (t.props?.SpriteGridPos ?? '0,0').split(',').map(Number); return { col: c || 0, row: r || 0 }; };

// Wall piece type from its tiledef flags. PZ lays each wall material out as a 4-col x 2-row block: top row
// [WallW, WallN, corner(WallNW), pillar/end(WallSE)], bottom row [WindowW, WindowN, DoorWallW, DoorWallN].
function wallPieceLabel(p: Record<string, string> | null): string {
  if (!p) return 'piece';
  if ('WallNW' in p) return 'Corner';
  if ('WallSE' in p) return p.PaintingType === 'pillar' ? 'Pillar' : 'End';
  if ('DoorWallN' in p) return 'Door (N)';
  if ('DoorWallW' in p) return 'Door (W)';
  if ('WindowN' in p) return 'Window (N)';
  if ('WindowW' in p) return 'Window (W)';
  if ('WallN' in p) return 'Wall (N)';
  if ('WallW' in p) return 'Wall (W)';
  return 'piece';
}
const WALL_PIECE_ORDER = ['Wall (N)', 'Wall (W)', 'Corner', 'Pillar', 'End', 'Window (N)', 'Window (W)', 'Door (N)', 'Door (W)', 'piece'];

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
  private sheetW = new Map<string, number>(); // sheet -> tile columns, for the wall block-grouping geometry
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
    for (const [sheet, def] of tiledefs) this.sheetW.set(sheet, def.wTiles);
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

  /** Browsable groups for a category. Walls collapse into per-material sets (one card = one colour/
   *  wallpaper, holding its N/W walls, corner, pillar, window and door pieces); other categories return
   *  one single-piece set per tile so the browser stays uniform. */
  sets(category?: TileCategory): TileSet[] {
    const tiles = this.list(category);
    const short = (t: TileInfo) => `${t.sheet.replace(/^(floors_|walls_|furniture_|appliances_|lighting_)/, '')} ${t.index}`;
    const single = (t: TileInfo): TileSet => ({ id: t.name, label: short(t), category: t.category, sheet: t.sheet, rep: t, defaultPiece: t.name, pieces: [{ label: 'tile', tile: t, tiles: one(t) }] });
    const byFirst = (rows: { first: number; set: TileSet }[]) => rows.sort((a, b) => a.set.sheet.localeCompare(b.set.sheet) || a.first - b.first).map((x) => x.set);

    if (category === 'wall') {
      // group by the 4-col x 2-row material block (see wallPieceLabel) within each sheet
      const groups = new Map<string, TileInfo[]>();
      for (const t of tiles) {
        const w = this.sheetW.get(t.sheet) || 8;
        const col = t.index % w, row = Math.floor(t.index / w);
        const id = `${t.sheet}#${Math.floor(row / 2)}_${Math.floor(col / 4)}`;
        const g = groups.get(id) ?? groups.set(id, []).get(id)!; g.push(t);
      }
      const matCount = new Map<string, number>();
      const out: { first: number; set: TileSet }[] = [];
      for (const ts of groups.values()) {
        ts.sort((a, b) => a.index - b.index);
        const pieces: TilePiece[] = ts.map((t) => ({ label: wallPieceLabel(t.props), tile: t, tiles: one(t) }))
          .sort((a, b) => WALL_PIECE_ORDER.indexOf(a.label) - WALL_PIECE_ORDER.indexOf(b.label));
        const material = ts.map((t) => t.props?.MaterialType).find(Boolean) || 'Wall';
        const mk = `${ts[0].sheet}:${material}`; const n = (matCount.get(mk) ?? 0) + 1; matCount.set(mk, n);
        const rep = pieces.find((p) => p.label === 'Corner')?.tile ?? pieces.find((p) => p.label === 'Wall (N)')?.tile ?? ts[0];
        const def = pieces.find((p) => p.label === 'Wall (N)')?.tile ?? rep;
        out.push({ first: ts[0].index, set: { id: `${ts[0].sheet}#${ts[0].index}`, label: `${material} ${n}`, category: 'wall', sheet: ts[0].sheet, rep, defaultPiece: def.name, pieces } });
      }
      return byFirst(out);
    }

    if (category === 'furniture') {
      // group by item (CustomName + GroupName, e.g. "White Fridge"); each piece is one FACING (S/E/N/W),
      // carrying every sprite of that orientation so a multi-tile item (couch, bed) places as a whole
      const facing = (t: TileInfo) => (t.props?.Facing ?? '').toUpperCase().replace('-', '') || 'S';
      const rank: Record<string, number> = { S: 0, E: 1, N: 2, W: 3 };
      const groups = new Map<string, TileInfo[]>();
      for (const t of tiles) {
        const p = t.props ?? {};
        const key = `${t.sheet}|${p.CustomName ?? short(t)}|${p.GroupName ?? ''}`;
        const g = groups.get(key) ?? groups.set(key, []).get(key)!; g.push(t);
      }
      const out: { first: number; set: TileSet }[] = [];
      for (const ts of groups.values()) {
        ts.sort((a, b) => a.index - b.index);
        if (ts.length === 1) { out.push({ first: ts[0].index, set: single(ts[0]) }); continue; }
        const p0 = ts[0].props ?? {};
        const label = ((p0.GroupName ? `${p0.GroupName} ` : '') + (p0.CustomName ?? short(ts[0]))).trim();
        const byFacing = new Map<string, TileInfo[]>();
        for (const t of ts) { const f = facing(t); const g = byFacing.get(f) ?? byFacing.set(f, []).get(f)!; g.push(t); }
        const pieces: TilePiece[] = [];
        for (const [f, sprites] of byFacing) {
          const anchor = sprites.find((s) => gridPos(s).col === 0 && gridPos(s).row === 0) ?? sprites[0];
          const a = gridPos(anchor);
          const tilesOfPiece: TilePieceTile[] = sprites.map((s) => { const g = gridPos(s); return { tile: s, dx: g.col - a.col, dy: g.row - a.row }; })
            .sort((x, y) => (x.dx * x.dx + x.dy * x.dy) - (y.dx * y.dx + y.dy * y.dy)); // anchor (0,0) first
          pieces.push({ label: f, tile: anchor, tiles: tilesOfPiece });
        }
        pieces.sort((x, y) => (rank[x.label] ?? 9) - (rank[y.label] ?? 9));
        const rep = pieces.find((p) => p.label === 'S')?.tile ?? pieces[0].tile;
        out.push({ first: ts[0].index, set: { id: `${ts[0].sheet}#${ts[0].index}`, label, category: 'furniture', sheet: ts[0].sheet, rep, defaultPiece: rep.name, pieces } });
      }
      return byFirst(out);
    }

    return tiles.map(single);
  }

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

  /** Thumbnail of a whole multi-tile piece (a 2-tile couch, a 2x2 bed): each sprite composited at its iso
   *  cell offset (2x diamond = 128x64, so +1 in x is +64,+32 on screen), back-to-front, then trimmed. */
  async compositeThumb(tiles: TilePieceTile[]): Promise<string> {
    if (tiles.length <= 1) return this.thumbUrl(tiles[0]?.tile.name ?? '');
    const key = 'grp:' + tiles.map((t) => t.tile.name).join(',');
    const cached = this.thumbs.get(key); if (cached) return cached;
    const HW = 64, HH = 32; // half a 2x tile diamond
    const pos = tiles.map((t) => ({ t, sx: HW * (t.dx - t.dy), sy: HH * (t.dx + t.dy) }));
    const imgs = await Promise.all(pos.map((p) => this.page(p.t.tile.pack, p.t.tile.page)));
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pos) { minX = Math.min(minX, p.sx); minY = Math.min(minY, p.sy); maxX = Math.max(maxX, p.sx + p.t.tile.full.w); maxY = Math.max(maxY, p.sy + p.t.tile.full.h); }
    const c = document.createElement('canvas'); c.width = maxX - minX; c.height = maxY - minY;
    const ctx = c.getContext('2d')!; ctx.imageSmoothingEnabled = false;
    const order = pos.map((p, i) => ({ p, img: imgs[i] })).sort((a, b) => (a.p.t.dx + a.p.t.dy) - (b.p.t.dx + b.p.t.dy) || a.p.t.dx - b.p.t.dx);
    for (const { p, img } of order) { const t = p.t.tile; ctx.drawImage(img, t.rect.x, t.rect.y, t.rect.w, t.rect.h, p.sx - minX + t.offset.x, p.sy - minY + t.offset.y, t.rect.w, t.rect.h); }
    const url = trimCanvas(c).toDataURL('image/png');
    this.thumbs.set(key, url);
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
    // The atlas pixels are sRGB; tag them so they're linearised on sample (else they render too bright
    // against the sRGB-encoded output, even with the ambient dim). magFilter nearest keeps them crisp.
    tex.colorSpace = THREE.SRGBColorSpace; tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.NearestFilter;
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

  /** The full authored sprite as a THREE texture, for standing objects (walls/furniture) rendered as
   *  camera-facing billboards. sRGB + nearest to match placed floors and the game look. Cached. */
  async spriteTexture(name: string): Promise<{ tex: THREE.Texture; full: { w: number; h: number } } | null> {
    const t = this.tiles.get(name); if (!t) return null;
    const key = 'sprite:' + name;
    let tex = this.texCache.get(key);
    if (!tex) {
      const canvas = await this.spriteCanvas(name); if (!canvas) return null;
      tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace; tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.NearestFilter;
      tex.generateMipmaps = false; tex.needsUpdate = true;
      this.texCache.set(key, tex);
    }
    return { tex, full: t.full };
  }
}

async function bytesToImage(bytes: Uint8Array): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: 'image/png' }));
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
  URL.revokeObjectURL(url);
  return img;
}
