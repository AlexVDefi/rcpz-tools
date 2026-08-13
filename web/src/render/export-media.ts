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
 *  transparency when bg is transparent.
 *  mode 'clip' (anim only): one exact loop of the current clip, sampled evenly from t=0 to just
 *  before the loop point, with the per-frame delay set so it plays at `speed` (the viewer's
 *  playback rate). This yields a seamless loop. mode 'fixed': a `seconds`-long real-time GIF. */
export async function exportGif(eng: ExportEngine, w: number, h: number, bg: BgConfig,
  opts: { mode: 'clip' | 'fixed'; seconds: number; fps: number; speed: number; content: Content; colors?: number; onProgress?: (p: number) => void }): Promise<Blob> {
  const restore = eng.beginExport(w, h);
  const cap = document.createElement('canvas'); cap.width = w; cap.height = h;
  const ctx = cap.getContext('2d', { willReadFrequently: true })!;
  const gif = GIFEncoder();
  const transparent = bg.mode === 'transparent';
  const format = transparent ? 'rgba4444' : 'rgb565';
  const dur = eng.getDuration();
  const speed = opts.speed || 1;
  eng.setLoop(true);
  const clipLoop = opts.content === 'anim' && opts.mode === 'clip';
  const frames = clipLoop
    ? Math.max(2, Math.min(150, Math.round(dur * opts.fps)))          // one loop, ~fps samples per clip-second
    : Math.max(1, Math.round(opts.seconds * opts.fps));
  const delay = clipLoop
    ? Math.max(20, Math.round((dur / speed / frames) * 1000))         // whole loop lasts dur/speed seconds
    : Math.round(1000 / opts.fps);
  const seekTo = (p: number) => {
    if (opts.content === 'turntable') eng.setSpinAngle(p * Math.PI * 2);
    else if (clipLoop) eng.seek(p);                                    // clip time = p*dur; last frame is just before the seam
    else eng.seek(((p * opts.seconds) % dur) / dur);
  };
  try {
    // Pass 1: render + composite every frame, keep its pixels. We build ONE palette shared by all frames
    // (a per-frame palette drifts between frames -> colour flicker, and can drop the transparent entry ->
    // a black box in that frame). One palette = stable colours and one consistent transparent index.
    const framesData: Uint8ClampedArray[] = [];
    for (let i = 0; i < frames; i++) {
      seekTo(i / frames);
      eng.renderFrame();
      composite(ctx, w, h, eng, bg);
      framesData.push(ctx.getImageData(0, 0, w, h).data);
      opts.onProgress?.(((i + 1) / frames) * 0.6);
      if (i % 4 === 0) await new Promise((r) => setTimeout(r, 0)); // yield so the UI can paint progress
    }
    // One global palette from a subsample of all frames. oneBitAlpha keeps transparency crisp + reserves a
    // real transparent entry, so every frame shares the same transparent index (no stray black frame).
    const sample = sampleFrames(framesData, w * h);
    const qopts = (transparent ? { format, oneBitAlpha: true } : { format }) as Parameters<typeof quantize>[2];
    const maxColors = Math.max(2, Math.min(256, Math.round(opts.colors ?? 256))); // fewer colours = smaller file, more banding
    let palette = quantize(sample, maxColors, qopts);
    let tIndex = -1;
    if (transparent) {
      tIndex = palette.findIndex((c) => c[3] === 0);
      if (tIndex < 0) { if (palette.length >= 256) palette = palette.slice(0, 255); palette = [...palette, [0, 0, 0, 0]]; tIndex = palette.length - 1; }
    }
    // Pass 2: apply the shared palette to every frame
    for (let i = 0; i < frames; i++) {
      const index = applyPalette(framesData[i], palette, format);
      gif.writeFrame(index, w, h, { palette, delay, transparent: tIndex >= 0, transparentIndex: tIndex >= 0 ? tIndex : 0 });
      opts.onProgress?.(0.6 + ((i + 1) / frames) * 0.4);
      if (i % 8 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    gif.finish();
    return new Blob([gif.bytes() as unknown as BlobPart], { type: 'image/gif' });
  } finally { restore(); }
}

// Subsample pixels across every frame (capped) so the single quantise stays fast but representative.
function sampleFrames(frames: Uint8ClampedArray[], perFramePx: number): Uint8ClampedArray {
  const MAX = 1 << 18; // ~262k sample pixels is plenty for a 256-colour palette
  const total = frames.length * perFramePx;
  const stride = Math.max(1, Math.floor(total / MAX));
  const out = new Uint8ClampedArray(Math.ceil(total / stride) * 4);
  let o = 0, g = 0;
  for (const fd of frames) {
    for (let px = 0; px < perFramePx; px++, g++) {
      if (g % stride) continue;
      const si = px << 2, di = o << 2;
      out[di] = fd[si]; out[di + 1] = fd[si + 1]; out[di + 2] = fd[si + 2]; out[di + 3] = fd[si + 3];
      o++;
    }
  }
  return out.subarray(0, o << 2);
}

export type VideoCodec = 'auto' | 'h264' | 'h265' | 'vp9';
export type VideoQuality = 'low' | 'medium' | 'high';

// Candidate mime strings per codec, best first. MediaRecorder support is browser/OS/hardware dependent
// (H.265/HEVC recording in particular is rare), so we probe isTypeSupported and fall back to auto.
const CODEC_MIMES: Record<VideoCodec, string[]> = {
  h264: ['video/mp4;codecs=avc1.640028', 'video/mp4;codecs=avc1.42E01E', 'video/mp4'],
  h265: ['video/mp4;codecs=hvc1.1.6.L93.B0', 'video/mp4;codecs=hev1.1.6.L93.B0', 'video/mp4;codecs=hvc1', 'video/mp4;codecs=hev1'],
  vp9: ['video/webm;codecs=vp9', 'video/webm'],
  auto: ['video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'],
};
const supported = (c: string) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(c);
function pickVideoMime(codec: VideoCodec = 'auto'): string {
  for (const c of CODEC_MIMES[codec] ?? CODEC_MIMES.auto) if (supported(c)) return c;
  for (const c of CODEC_MIMES.auto) if (supported(c)) return c; // requested codec unavailable: fall back
  return 'video/webm';
}
/** Is a codec actually available in this browser? (For greying out unsupported picks in the UI.) */
export function codecSupported(codec: VideoCodec): boolean { return codec === 'auto' || (CODEC_MIMES[codec] ?? []).some(supported); }

/** Real-time video capture via MediaRecorder. Always composites over the chosen background
 *  (video codecs here don't carry alpha). Returns the blob + file extension. */
export async function exportVideo(eng: ExportEngine, w: number, h: number, bg: BgConfig,
  opts: { seconds: number; fps: number; content: Content; codec?: VideoCodec; quality?: VideoQuality; onProgress?: (p: number) => void }): Promise<{ blob: Blob; ext: string }> {
  const restore = eng.beginExport(w, h);
  const cap = document.createElement('canvas'); cap.width = w; cap.height = h;
  const ctx = cap.getContext('2d')!;
  const mime = pickVideoMime(opts.codec ?? 'auto');
  const stream = cap.captureStream(opts.fps);
  const qFactor = { low: 0.06, medium: 0.12, high: 0.24 }[opts.quality ?? 'high']; // bits per pixel-second
  const bitrate = Math.min(60_000_000, Math.round(w * h * opts.fps * qFactor));
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
