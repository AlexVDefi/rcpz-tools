import { useEffect, useState } from 'react';

// Lazily resolves a thumbnail URL (only mounts for cards the virtualized grid renders).
// `depKey` re-requests when it changes (e.g. gender swap). Shows a subtle placeholder
// while the shared render queue works through the visible cards.
export function Thumb({ depKey, getUrl }: { depKey: string; getUrl: () => Promise<string> }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setUrl(null); setFailed(false);
    getUrl().then((u) => { if (alive) setUrl(u); }).catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depKey]);

  if (failed) return <span style={{ color: '#3a3a44', fontSize: 22 }}>—</span>;
  if (!url) return <div style={{ width: 22, height: 22, borderRadius: '50%', border: '2px solid #2a2a34', borderTopColor: '#5b8cff', animation: 'thumbspin 0.8s linear infinite' }} />;
  // width/height 100% (not max-*) so the image scales UP to fill a larger card, not just
  // shrinks to fit a smaller one; objectFit:contain keeps its aspect.
  return <img src={url} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }} />;
}
