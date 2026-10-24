import { useEffect, useState } from 'react';
import api from '../lib/api';

/**
 * Polls GET /api/startup-status (the open, read-only endpoint the backend serves while it initialises) and returns the last REAL
 * snapshot, or null when the server has not answered. Only runs while `enabled`; the timer and any in-flight result are
 * discarded on unmount so nothing leaks or sets state afterwards. No artificial delay: the first request is immediate.
 */
export function useStartupStatus(enabled, intervalMs = 700) {
  const [snapshot, setSnapshot] = useState(null);

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    let timer = null;

    const tick = async () => {
      try {
        const { data } = await api.get('/startup-status', { timeout: 1500 });
        if (!cancelled) setSnapshot(data && typeof data === 'object' ? data : null);
      } catch {
        if (!cancelled) setSnapshot(null);          // unreachable right now: report "not verified", do not keep a stale success
      }
      if (!cancelled) timer = setTimeout(tick, intervalMs);
    };
    tick();

    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [enabled, intervalMs]);

  return snapshot;
}

export default useStartupStatus;
