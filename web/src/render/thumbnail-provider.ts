// Caches thumbnails: memory (object URLs) -> IndexedDB (blobs) -> render. Dedups
// in-flight requests so scrolling a card back into view never re-renders. One shared
// ThumbnailRenderer (single GL context) does the work, serialized internally.
import { ThumbnailRenderer, type Ctx, type IdleClip } from './thumbnail-renderer';
import { idbCache } from '../platform/idb';

const VERSION = 10; // bump to invalidate all cached thumbnails (v10: held-item texture flipY fix)
const HAIR_TINT = [0.353, 0.227, 0.125]; // neutral brown (#5a3a20) so hair/beard shapes read

export class ThumbnailProvider {
  private renderer: ThumbnailRenderer;
  private urls = new Map<string, string>();
  private inflight = new Map<string, Promise<string>>();

  constructor(ctx: Ctx, idleClip?: IdleClip) { this.renderer = new ThumbnailRenderer(ctx, idleClip); }

  private resolveKey(key: string, render: () => Promise<Blob>): Promise<string> {
    const cached = this.urls.get(key);
    if (cached) return Promise.resolve(cached);
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const p = (async () => {
      let blob = (await idbCache.get(key)) as Blob | undefined;
      if (!(blob instanceof Blob)) { blob = await render(); idbCache.put(key, blob).catch(() => {}); }
      const url = URL.createObjectURL(blob);
      this.urls.set(key, url);
      this.inflight.delete(key);
      return url;
    })();
    this.inflight.set(key, p);
    return p;
  }

  clothing(item: { name: string; kind: string; facet?: string }, gender: 'male' | 'female', onBody: boolean): Promise<string> {
    const mode = onBody ? 'body' : 'solo';
    return this.resolveKey(`thumb:cloth:${mode}:${gender}:${item.name}:v${VERSION}`, () => this.renderer.clothingThumb(item, gender, onBody));
  }

  held(item: { name: string }): Promise<string> {
    return this.resolveKey(`thumb:held:${item.name}:v${VERSION}`, () => this.renderer.heldThumb(item));
  }

  hair(style: { name: string; model?: string; texture?: string }, kind: 'hair' | 'beard', gender: 'male' | 'female'): Promise<string> {
    return this.resolveKey(`thumb:hair:${kind}:${gender}:${style.name}:v${VERSION}`, () => this.renderer.hairThumb(style, gender, HAIR_TINT));
  }

  clip(clip: { id: string; rel: string; format: string }): Promise<string> {
    return this.resolveKey(`thumb:clip:${clip.id}:v${VERSION}`, () => this.renderer.clipThumb(clip));
  }

  dispose() {
    for (const u of this.urls.values()) URL.revokeObjectURL(u);
    this.urls.clear();
    this.renderer.dispose();
  }
}
