// The list of community mods whose assets are hosted (baked + on R2), for the app to layer over
// the built-in vanilla assets. Public, no auth. Empty when the cloud API isn't configured.
import { CLOUD_API } from './config';

export interface HostedMod { modId: string; title: string; url: string; preview?: string | null; author?: string | null; }

export async function fetchHostedMods(): Promise<HostedMod[]> {
  if (!CLOUD_API) return [];
  try {
    const res = await fetch(`${CLOUD_API}/mods/hosted`);
    if (!res.ok) return [];
    const j = (await res.json()) as { mods?: HostedMod[] };
    return Array.isArray(j.mods) ? j.mods : [];
  } catch { return []; }
}
