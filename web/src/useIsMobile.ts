import { useState, useEffect } from 'react';

// Reactive phone-sized-viewport check. Drives the mobile layout + the "hosted assets only, no local
// files" path (the File System Access API isn't available on phones anyway). Updates on resize and
// orientation change. 760px covers phones in both orientations while leaving tablets on the desktop
// layout (which they can handle).
export function useIsMobile(query = '(max-width: 760px)'): boolean {
  const [match, setMatch] = useState(() => (typeof window !== 'undefined' ? window.matchMedia(query).matches : false));
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setMatch(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return match;
}
