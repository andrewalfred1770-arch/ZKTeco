import { create } from 'zustand';
import api from '../lib/api';

// Same backendBase resolution as lib/api.js — needed to turn the relative
// '/uploads/company/...' paths the backend returns into absolute URLs the
// renderer (and the print/PDF documents) can load.
const backendBase = window.electron?.backendBaseUrl
  ?? (window.electron?.backendPort ? `http://localhost:${window.electron.backendPort}` : '');

/** Resolves an '/uploads/...' path returned by the API into a loadable URL. */
export function resolveCompanyAssetUrl(value) {
  if (!value) return '';
  if (/^https?:\/\//i.test(value) || value.startsWith('data:')) return value;
  return `${backendBase}${value}`;
}

// F-15: latest-wins ordering for the settings state. Without it, a GET that started
// before a save (or before a newer GET) could land afterwards and put the older
// company data — and the banner derived from it — back on screen. Every write
// below bumps the same counter, so any request still in flight at that moment is
// ignored when it arrives; the newest result always wins. Module-level (not
// per-page): this store is the single owner of the company settings.
let requestSeq = 0;

/**
 * F-15: should the company settings be re-fetched when the realtime link changes
 * state? Yes on every transition INTO 'connected' that follows a drop; and, for the
 * very first connect, only when the initial load did not succeed. No polling.
 */
export function shouldRefetchOnStatus(prev, next, { fetchError, loaded }) {
  if (prev === null || next !== 'connected' || prev === 'connected') return false;
  return prev !== 'connecting' || !!fetchError || !loaded;
}

const useCompanySettingsStore = create((set, get) => ({
  settings: {},
  loading: false,
  loaded: false,
  // Distinguishes "the API call itself failed" (e.g. a 401 from a
  // misconfigured server, or the server being unreachable) from a genuine
  // first-run empty company — both leave `settings` at `{}`, but only the
  // latter should trigger the "company not configured yet" onboarding banner.
  fetchError: false,

  async fetch() {
    const mine = ++requestSeq;
    set({ loading: true });
    try {
      const { data } = await api.get('/settings/company');
      if (mine !== requestSeq) return;     // a newer fetch / save superseded this response
      set({ settings: data || {}, loading: false, loaded: true, fetchError: false });
    } catch {
      if (mine !== requestSeq) return;
      set({ loading: false, fetchError: true });
    }
  },

  /** Saves a partial map of text fields. `actorName` is recorded in the audit log. */
  async update(partial, actorName) {
    const { data } = await api.put('/settings/company', { ...partial, changedByName: actorName });
    requestSeq++;
    set({ settings: data || get().settings, loaded: true, fetchError: false });
    return data;
  },

  async uploadImage(field, file, actorName) {
    const form = new FormData();
    form.append('file', file);
    form.append('changedByName', actorName);
    const { data } = await api.post(`/settings/company/upload/${field}`, form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    if (data?.settings) { requestSeq++; set({ settings: data.settings, loaded: true, fetchError: false }); }
    return data;
  },

  async deleteImage(field, actorName) {
    const { data } = await api.delete(`/settings/company/upload/${field}`, {
      data: { changedByName: actorName },
    });
    if (data?.settings) { requestSeq++; set({ settings: data.settings, loaded: true, fetchError: false }); }
    return data;
  },
}));

export default useCompanySettingsStore;
