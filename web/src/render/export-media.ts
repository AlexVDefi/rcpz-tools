// Client-side exporters: still PNG, animated GIF (gifenc), and video (MediaRecorder ->
// MP4 where Chrome supports it, else WebM). Nothing leaves the browser - every frame is
// composited on a local 2D canvas and downloaded via a blob URL.
import { GIFEncoder, quantize, applyPalette } from 'gifenc';

export type BgConfig = { mode: 'transparent' | 'solid' | 'gradient'; color1: string; color2: string; angle: number };
export type Content = 'anim' | 'turntable';

// Minimal engine surface the exporters need (CharacterEngine implements it).
export interface ExportEngine {
  beginExport(w: number, h: number): () => void;
  renderFrame(): void;
  readonly webglCanvas: HTMLCanvasElement;
  getDuration(): number;
  seek(frac: number): void;
  setSpinAngle(rad: number): void;
  setLoop(on: boolean): void;
}

function drawBg(ctx: CanvasRenderingContext2D, w: number, h: number, bg: BgConfig) {
  if (bg.mode === 'transparent') return;
  if (bg.mode === 'solid') { ctx.fillStyle = bg.color1; ctx.fillRect(0, 0, w, h); return; }
  const a = (bg.angle * Math.PI) / 180;
  const len = Math.abs(w * Math.cos(a)) + Math.abs(h * Math.sin(a));
  const dx = (Math.cos(a) * len) / 2, dy = (Math.sin(a) * len) / 2;
  const g = ctx.createLinearGradient(w / 2 - dx, h / 2 - dy, w / 2 + dx, h / 2 + dy);
  g.addColorStop(0, bg.color1); g.addColorStop(1, bg.color2);
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
}

// Composite the current 3D frame over the background onto `ctx` (background first, then the
// transparent WebGL canvas on top). The WebGL buffer is already w x h (pixelRatio 1).
function composite(ctx: CanvasRenderingContext2D, w: number, h: number, eng: ExportEngine, bg: BgConfig) {
  ctx.clearRect(0, 0, w, h);
  drawBg(ctx, w, h, bg);
  ctx.drawImage(eng.webglCanvas, 0, 0, w, h);
}

export function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** Single still. Transparent bg is preserved in the PNG alpha. */
export async function exportPng(eng: ExportEngine, w: number, h: number, bg: BgConfig): Promise<Blob> {
  const restore = eng.beginExport(w, h);
  try {
    eng.renderFrame();
    const cap = document.createElement('canvas'); cap.width = w; cap.height = h;
    const ctx = cap.getContext('2d')!;
    composite(ctx, w, h, eng, bg);
    return await new Promise<Blob>((res) => cap.toBlob((b) => res(b!), 'image/png'));
  } finally { restore(); }
}

/** Animated GIF, frame-stepped (deterministic, faster than real time). Supports 1-bit
 *  transparency when bg is transparent. */
export async function exportGif(eng: ExportEngine, w: number, h: number, bg: BgConfig,
  opts: { seconds: number; fps: number; content: Content; onProgress?: (p: number) => void }): Promise<Blob> {
  const restore = eng.beginExport(w, h);
  const cap = document.createElement('canvas'); cap.width = w; cap.height = h;
  const ctx = cap.getContext('2d', { willReadFrequently: true })!;
  const gif = GIFEncoder();
  const transparent = bg.mode === 'transparent';
  const format = transparent ? 'rgba4444' : 'rgb565';
  const dur = eng.getDuration();
  eng.setLoop(true);
  try {
    const frames = Math.max(1, Math.round(opts.seconds * opts.fps));
    for (let i = 0; i < frames; i++) {
      const p = i / frames;
      if (opts.content === 'turntable') eng.setSpinAngle(p * Math.PI * 2);
      else eng.seek((((p * opts.seconds) % dur) / dur));
      eng.renderFrame();
      composite(ctx, w, h, eng, bg);
      const { data } = ctx.getImageData(0, 0, w, h);
      const palette = quantize(data, 256, { format });
      const index = applyPalette(data, palette, format);
      const tIndex = transparent ? palette.findIndex((c) => c[3] === 0) : -1;
      gif.writeFrame(index, w, h, { palette, delay: Math.round(1000 / opts.fps), transparent: tIndex >= 0, transparentIndex: tIndex >= 0 ? tIndex : 0 });
      opts.onProgress?.((i + 1) / frames);
      if (i % 4 === 0) await new Promise((r) => setTimeout(r, 0)); // yield so the UI can paint progress
    }
    gif.finish();
    return new Blob([gif.bytes() as unknown as BlobPart], { type: 'image/gif' });
  } finally { restore(); }
}

function pickVideoMime(): string {
  const cands = ['video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  for (const c of cands) if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(c)) return c;
  return 'video/webm';
}

/** Real-time video capture via MediaRecorder. Always composites over the chosen background
 *  (video codecs here don't carry alpha). Returns the blob + file extension. */
export async function exportVideo(eng: ExportEngine, w: number, h: number, bg: BgConfig,
  opts: { seconds: number; fps: number; content: Content; onProgress?: (p: number) => void }): Promise<{ blob: Blob; ext: string }> {
  const restore = eng.beginExport(w, h);
  const cap = document.createElement('canvas'); cap.width = w; cap.height = h;
  const ctx = cap.getContext('2d')!;
  const mime = pickVideoMime();
  const stream = cap.captureStream(opts.fps);
  const bitrate = Math.min(24_000_000, Math.round(w * h * opts.fps * 0.15));
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitrate });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const dur = eng.getDuration();
  eng.setLoop(true);
  const startedAt = performance.now();
  let running = true;
  const frameLoop = () => {
    if (!running) return;
    const elapsed = (performance.now() - startedAt) / 1000;
    const p = Math.min(1, elapsed / opts.seconds);
    if (opts.content === 'turntable') eng.setSpinAngle(p * Math.PI * 2);
    else eng.seek((elapsed % dur) / dur);
    eng.renderFrame();
    composite(ctx, w, h, eng, bg);
    opts.onProgress?.(p);
    requestAnimationFrame(frameLoop);
  };
  return await new Promise<{ blob: Blob; ext: string }>((resolve) => {
    rec.onstop = () => { running = false; restore(); resolve({ blob: new Blob(chunks, { type: mime }), ext: mime.includes('mp4') ? 'mp4' : 'webm' }); };
    rec.start();
    requestAnimationFrame(frameLoop);
    setTimeout(() => rec.stop(), opts.seconds * 1000);
  });
}
