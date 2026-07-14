import React, { useEffect, useState } from 'react';
import { WifiOff } from 'lucide-react';

export default function NetworkBanner() {
  const [offline, setOffline] = useState(!navigator.onLine);

  useEffect(() => {
    const on  = () => setOffline(false);
    const off = () => setOffline(true);
    window.addEventListener('online',  on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);

  if (!offline) return null;

  return (
    <div
      dir="rtl"
      style={{
        position: 'fixed', top: 0, right: 0, left: 0, zIndex: 99999,
        background: '#DC2626', color: '#fff',
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
        padding: '8px 16px', fontSize: 13, fontFamily: 'Cairo,sans-serif', fontWeight: 600,
      }}
    >
      <WifiOff style={{ width: 15, height: 15, flexShrink: 0 }} />
      لا يوجد اتصال بالشبكة — بعض الميزات قد لا تعمل
    </div>
  );
}
