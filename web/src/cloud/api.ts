import { CLOUD_API } from './config';
import { encodeShareMeta, type ShareMeta } from './share-meta';

export interface UploadResult { key: string; url: string; size: number; }

// Upload a rendered blob to the Worker, which verifies the Supabase token, enforces the quota,
// stores the object in R2, and records it. Uses XHR so we can report upload progress (useful for
// larger MP4s). An optional meta manifest (what the render depicts) rides along in a header.
// Returns the object key, its shareable URL, and stored size.
export function uploadRender(
  token: string,
  blob: Blob,
  opts: { kind: 'png' | 'gif' | 'mp4'; ext: string; meta?: ShareMeta; onProgress?: (frac: number) => void },
): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    if (!CLOUD_API) { reject(new Error('Online sharing is not configured.')); return; }
    const xhr = new XMLHttpRequest();
    const qs = new URLSearchParams({ kind: opts.kind, ext: opts.ext });
    xhr.open('POST', `${CLOUD_API}/upload?${qs.toString()}`);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('Content-Type', blob.type || 'application/octet-stream');
    if (opts.meta) { try { xhr.setRequestHeader('X-Share-Meta', encodeShareMeta(opts.meta)); } catch { /* skip meta, still upload */ } }
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) opts.onProgress?.(e.loaded / e.total); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText) as UploadResult); } catch { reject(new Error('Unexpected server response.')); }
      } else {
        reject(new Error(errorFrom(xhr.responseText, xhr.status)));
      }
    };
    xhr.onerror = () => reject(new Error('Network error during upload.'));
    xhr.send(blob);
  });
}

export async function deleteUpload(token: string, key: string): Promise<void> {
  if (!CLOUD_API) throw new Error('Online sharing is not configured.');
  const res = await fetch(`${CLOUD_API}/object?key=${encodeURIComponent(key)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(errorFrom(await res.text(), res.status));
}

// Permanently delete the signed-in user's account and every render they've shared. Irreversible.
export async function deleteAccount(token: string): Promise<void> {
  if (!CLOUD_API) throw new Error('Online sharing is not configured.');
  const res = await fetch(`${CLOUD_API}/account`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(errorFrom(await res.text(), res.status));
}

export const fileUrl = (key: string) => `${CLOUD_API}/f/${key}`;
// The branded "custom player" page for a share: shows the render with the character name, the mods
// used, and the PZ Survivor Studio brand. Served by the Worker at /p/<key>.
export const playerUrl = (key: string) => `${CLOUD_API}/p/${key}`;

function errorFrom(body: string, status: number): string {
  try { const j = JSON.parse(body); if (j?.error) return String(j.error); } catch { /* not json */ }
  if (status === 413) return 'That would exceed your 100 MB storage limit.';
  if (status === 401) return 'Your session expired. Sign in again.';
  return `Request failed (${status}).`;
}
