import { useCallback, useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { getSupabase } from './supabase';
import { deleteUpload, fileUrl } from './api';
import { QUOTA_BYTES } from './config';

export interface UploadRow {
  id: string;
  key: string;
  size: number;
  content_type: string | null;
  kind: string | null;
  created_at: string;
  url: string;
}

// The signed-in user's shares, read straight from Supabase under row-level security (each user
// only ever sees their own rows). Usage = the sum of their sizes; the Worker enforces the same
// cap authoritatively on upload.
export function useCloudUploads(session: Session | null) {
  const sb = getSupabase();
  const [rows, setRows] = useState<UploadRow[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!sb || !session) { setRows([]); return; }
    setLoading(true);
    try {
      const { data } = await sb.from('uploads')
        .select('id,key,size,content_type,kind,created_at')
        .order('created_at', { ascending: false });
      setRows((data ?? []).map((r) => ({ ...r, size: Number(r.size), url: fileUrl(r.key) })) as UploadRow[]);
    } finally { setLoading(false); }
  }, [sb, session]);

  useEffect(() => { refresh(); }, [refresh]);

  const remove = useCallback(async (key: string) => {
    if (!session) return;
    await deleteUpload(session.access_token, key);
    await refresh();
  }, [session, refresh]);

  const used = rows.reduce((n, r) => n + r.size, 0);
  return { rows, used, limit: QUOTA_BYTES, loading, refresh, remove };
}
