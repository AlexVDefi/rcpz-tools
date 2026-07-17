// Browser ImageOps (Canvas2D) — replaces the sharp compositor (src/character/compose.js).
// Builds the character body diffuse: skin base, model-less garment base textures 'over',
// then the equipped masks erase the covered skin. Phase 0.3 confirmed PZ masks encode
// coverage in ALPHA, so 'destination-out' (which keys on source alpha) is the faithful
// erase. Tint is a pixel-loop RGB multiply (NOT Canvas 'multiply', which would clobber
// the garment's cutout alpha).

async function toBitmap(bytes: Uint8Array): Promise<ImageBitmap> {
  return createImageBitmap(new Blob([bytes as unknown as BlobPart], { type: 'image/png' }));
}

export interface BodyLayer { bytes: Uint8Array; tint?: number[] | null; }

/**
 * Compose the body diffuse onto a canvas (used directly as a three texture).
 * The skin atlas is small (256px) while mod garment atlases are often larger in the
 * SAME UV layout, so normalise everything to the largest side so the atlas lines up.
 */
export async function composeBody(skin: Uint8Array, layers: BodyLayer[] = [], masks: Uint8Array[] = []): Promise<HTMLCanvasElement> {
  const skinBmp = await toBitmap(skin);
  const layerBmps = await Promise.all(layers.map((l) => toBitmap(l.bytes)));
  const maskBmps = await Promise.all(masks.map(toBitmap));

  let target = Math.max(skinBmp.width, skinBmp.height);
  for (const b of [...layerBmps, ...maskBmps]) target = Math.max(target, b.width, b.height);

  const canvas = document.createElement('canvas');
  canvas.width = target; canvas.height = target;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;

  ctx.drawImage(skinBmp, 0, 0, target, target);

  for (let i = 0; i < layerBmps.length; i++) {
    const bmp = layerBmps[i];
    const tint = layers[i].tint;
    if (tint) {
      // RGB-multiply on a temp canvas, preserving the garment's own alpha
      const tc = document.createElement('canvas');
      tc.width = bmp.width; tc.height = bmp.height;
      const tctx = tc.getContext('2d')!;
      tctx.drawImage(bmp, 0, 0);
      const img = tctx.getImageData(0, 0, bmp.width, bmp.height);
      const d = img.data;
      for (let p = 0; p < d.length; p += 4) { d[p] *= tint[0]; d[p + 1] *= tint[1]; d[p + 2] *= tint[2]; }
      tctx.putImageData(img, 0, 0);
      ctx.drawImage(tc, 0, 0, target, target);
    } else {
      ctx.drawImage(bmp, 0, 0, target, target);
    }
  }

  ctx.globalCompositeOperation = 'destination-out';
  for (const m of maskBmps) ctx.drawImage(m, 0, 0, target, target);
  ctx.globalCompositeOperation = 'source-over';

  skinBmp.close?.(); layerBmps.forEach((b) => b.close?.()); maskBmps.forEach((b) => b.close?.());
  return canvas;
}

/**
 * Finish an icon: raw RGBA render buffer -> PNG blob. GL vertical flip, optional PZ
 * horizontal mirror, tight alpha-trim (edge-to-edge), scale-to-fill, center. `nearest`
 * (imageSmoothingEnabled=false) is byte-exact to the sharp/Electron output; `lanczos3`
 * has no Canvas equivalent (falls back to high-quality smoothing, not pixel-identical).
 */
export async function renderIconPng(
  rawRGBA: Uint8Array, width: number, height: number,
  opts: { outSize?: number; downscale?: 'nearest' | 'lanczos3'; mirror?: boolean; padding?: number } = {},
): Promise<Blob> {
  const outSize = opts.outSize || 32;
  const nearest = (opts.downscale || 'nearest') === 'nearest';
  const mirror = opts.mirror !== false;
  const margin = typeof opts.padding === 'number' ? opts.padding : 0.03;

  // GL readback is bottom-up: flip vertically (and mirror horizontally) into a source canvas
  const src = document.createElement('canvas'); src.width = width; src.height = height;
  const sctx = src.getContext('2d')!;
  const imgData = new ImageData(Uint8ClampedArray.from(rawRGBA), width, height);
  const tmp = document.createElement('canvas'); tmp.width = width; tmp.height = height;
  tmp.getContext('2d')!.putImageData(imgData, 0, 0);
  sctx.translate(mirror ? width : 0, height);
  sctx.scale(mirror ? -1 : 1, -1);
  sctx.drawImage(tmp, 0, 0);

  // tight alpha bbox
  const px = sctx.getImageData(0, 0, width, height).data;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (px[(y * width + x) * 4 + 3] > 8) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  }
  const out = document.createElement('canvas'); out.width = outSize; out.height = outSize;
  const octx = out.getContext('2d')!;
  if (maxX >= 0) {
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    const inner = Math.max(1, Math.round(outSize * (1 - 2 * margin)));
    const scale = Math.min(inner / bw, inner / bh);
    const dw = Math.round(bw * scale), dh = Math.round(bh * scale);
    octx.imageSmoothingEnabled = !nearest;
    if (!nearest) octx.imageSmoothingQuality = 'high';
    octx.drawImage(src, minX, minY, bw, bh, Math.floor((outSize - dw) / 2), Math.floor((outSize - dh) / 2), dw, dh);
  }
  return new Promise((resolve) => out.toBlob((b) => resolve(b!), 'image/png'));
}
