import React, { useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { RefreshCw } from 'lucide-react';
import { getSocket, subscribeConnectionStatus } from '../lib/socket';

// ─── Socket connection-lifecycle indicator (EP-014) ───────────────────────────
// Distinct from NetworkBanner.jsx (raw browser online/offline) — this reflects
// the Socket.IO connection to the app's OWN backend specifically, which can be
// down (backend crashed, LAN server unreachable) while the browser/OS reports
// full network connectivity. Non-blocking by design (a small fixed pill, not a
// full-width banner) — never interrupts an in-progress edit or navigation.
export default function ConnectionStatusBanner() {
  const [status, setStatus] = useState('connecting');
  const prevStatus = useRef(status);

  useEffect(() => {
    getSocket(); // ensure the shared socket (and its listeners) exist
    const unsubscribe = subscribeConnectionStatus((next) => {
      if ((prevStatus.current === 'reconnecting' || prevStatus.current === 'disconnected') && next === 'connected') {
        toast.success('تم استعادة الاتصال', { id: 'conn-restored', duration: 2500 });
      }
      prevStatus.current = next;
      setStatus(next);
    });
    return unsubscribe;
  }, []);

  if (status !== 'reconnecting' && status !== 'disconnected') return null;

  return (
    <div
      dir="rtl"
      style={{
        position: 'fixed', bottom: 16, left: 16, zIndex: 99998,
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '7px 14px', borderRadius: 999,
        background: 'rgba(245,158,11,0.95)', color: '#fff',
        fontSize: 12.5, fontFamily: 'Cairo,sans-serif', fontWeight: 600,
        boxShadow: '0 4px 14px rgba(0,0,0,0.25)',
        pointerEvents: 'none',
      }}
    >
      <RefreshCw style={{ width: 13, height: 13, animation: 'spin 1.2s linear infinite', flexShrink: 0 }} />
      جارٍ إعادة الاتصال بالخادم…
    </div>
  );
}
