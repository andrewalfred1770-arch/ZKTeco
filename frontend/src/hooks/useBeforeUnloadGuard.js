import { useEffect } from 'react';
import { hasUnsavedWork } from '../lib/unsavedWork';

/**
 * Warns before a plain-browser tab is closed or reloaded while a screen holds unsaved work (lib/unsavedWork.js).
 *
 * Deliberately NOT installed inside Electron (window.electron exists there): a beforeunload veto in Electron cancels the unload
 * silently unless the main process also handles `will-prevent-unload`, and could keep the window from closing or the app from quitting
 * through the tray. In the desktop app the protection is the in-app navigation prompt (Layout) and the session-expiry overlay.
 */
export function useBeforeUnloadGuard() {
  useEffect(() => {
    if (typeof window === 'undefined' || window.electron) return undefined;
    const onBeforeUnload = (e) => {
      if (!hasUnsavedWork()) return undefined;
      e.preventDefault();
      e.returnValue = '';
      return '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);
}
