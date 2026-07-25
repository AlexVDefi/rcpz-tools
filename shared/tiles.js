// Tile catalogue: turns the parsed .pack indexes + .tiles tiledefs into one classified tile list the
// browser/placement UI (and a future bake) consume. Framework-agnostic - it holds only data (rects,
// offsets, category); decoding/cropping an atlas page is left to the caller (browser canvas / sharp).

export const TILE_CATEGORIES = ['floor', 'overlay', 'wall', 'furniture', 'vegetation', 'other'];

/** "floors_exterior_natural_01_5" -> { sheet:"floors_exterior_natural_01", index:5 }. */
export function sheetAndIndex(name) {
  const m = /^(.*)_(\d+)$/.exec(name);
  return m ? { sheet: m[1], index: Number(m[2]) } : { sheet: name, index: 0 };
}

function propsFor(tiledefs, sheet, index) {
  const s = tiledefs && tiledefs.get(sheet);
  const t = s && s.tiles[index];
  return t ? t.props : null;
}

const FURNITURE_PREFIX = /^(furniture_|appliances_|fixtures_|seating_|storage_|industry_|lighting_|camping_|crafted_|recreational_|constructedobjects_|carpentry_|trash_|garbage_)/;

/** Classify a tile into a layering category. Tiledef property signals are authoritative; the sheet-name
 *  prefix is the fallback (and the only signal for tiles with no tiledef, e.g. JumboTrees). Precedence:
 *  vegetation/tree -> wall -> overlay/rug -> floor -> furniture -> other. Overlay is tested BEFORE floor
 *  because rug sheets are named "floors_overlay_*" yet must layer ON TOP of a floor.
 *  @param {string} name @param {Record<string,string>|null} props tiledef props for this tile (or null) */
export function classifyTile(name, props) {
  const sheet = sheetAndIndex(name).sheet;
  const has = (k) => props != null && k in props;
  const low = name.toLowerCase(), sl = sheet.toLowerCase();

  if (has('tree') || has('vegitation') || has('vegetation') || /jumbo/.test(low) || sl.startsWith('vegetation_') || /^f_/.test(sl)) return 'vegetation';
  if (has('wall') || has('WallN') || has('WallW') || has('WallNW') || has('WallSE') || has('doorW') || has('doorN') || has('WallOverlay') || sl.startsWith('walls_') || sl.startsWith('fencing_')) return 'wall';
  if (has('FloorOverlay') || sl.includes('_overlay_') || sl.includes('rug')) return 'overlay';
  // NB: attachedFloor is NOT a floor signal - it means "sits on a floor" (vegetation/objects), so it's
  // excluded here (vegetation is already handled above). Real floors carry solidfloor/grass/diamond.
  if (has('solidfloor') || has('grassFloor') || has('diamondFloor') || sl.startsWith('floors_') || sl.startsWith('blends_') || sl.startsWith('street_')) return 'floor';
  if (has('IsMoveAble') || has('IsTable') || has('tableTop') || has('Surface') || has('CanBreak') || has('PickUpLevel') || has('container') || FURNITURE_PREFIX.test(sl)) return 'furniture';
  return 'other';
}

/** Combine parsed pack indexes + merged tiledefs into one tile catalogue (Map name -> TileInfo).
 *  `packs` = [{ id, pages }] where each page has { entries }; page ordinal is the array index. The
 *  first pack that defines a name wins (pass higher-priority packs first).
 *  TileInfo = { name, sheet, index, pack, page, rect{x,y,w,h}, offset{x,y}, full{w,h}, category, props } */
export function buildTileCatalogue(packs, tiledefs) {
  const tiles = new Map();
  for (const pack of packs) {
    pack.pages.forEach((page, pageIndex) => {
      for (const e of page.entries) {
        if (tiles.has(e.name)) continue;
        const { sheet, index } = sheetAndIndex(e.name);
        const props = propsFor(tiledefs, sheet, index);
        tiles.set(e.name, {
          name: e.name, sheet, index, pack: pack.id, page: pageIndex,
          rect: { x: e.x, y: e.y, w: e.w, h: e.h },
          offset: { x: e.ox, y: e.oy }, full: { w: e.fx, h: e.fy },
          category: classifyTile(e.name, props), props: props || null,
        });
      }
    });
  }
  return tiles;
}

/** Count tiles per category (for UI facets / validation). */
export function categoryHistogram(catalogue) {
  const h = Object.fromEntries(TILE_CATEGORIES.map((c) => [c, 0]));
  for (const t of catalogue.values()) h[t.category]++;
  return h;
}
