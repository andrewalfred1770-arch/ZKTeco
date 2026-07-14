import { create } from 'zustand';
import api from '../lib/api';

// Same backendBase resolution as lib/api.js — needed to turn the relative
// '/uploads/company/...' paths the backend returns into absolute URLs the
// renderer (and the print/PDF documents) can load.
const backendBase = window.electron?.backendPort
  ? `http://localhost:${window.electron.backendPort}`
  : '';

/** Resolves an '/uploads/...' path returned by the API into a loadable URL. */
export function resolveCompanyAssetUrl(value) {
  if (!value) return '';
  if (/^https?:\/\//i.test(value) || value.startsWith('data:')) return value;
  return `${backendBase}${value}`;
}

const useCompanySettingsStore = create((set, get) => ({
  settings: {},
  loading: false,
  loaded: false,

  async fetch() {
    set({ loading: true });
    try {
      const { data } = await api.get('/settings/company');
      set({ settings: data || {}, loading: false, loaded: true });
    } catch {
      set({ loading: false });
    }
  },

  /** Saves a partial map of text fields. `actorName` is recorded in the audit log. */
  async update(partial, actorName) {
    const { data } = await api.put('/settings/company', { ...partial, changedByName: actorName });
    set({ settings: data || get().settings, loaded: true });
    return data;
  },

  async uploadImage(field, file, actorName) {
    const form = new FormData();
    form.append('file', file);
    form.append('changedByName', actorName);
    const { data } = await api.post(`/settings/company/upload/${field}`, form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    if (data?.settings) set({ settings: data.settings, loaded: true });
    return data;
  },

  async deleteImage(field, actorName) {
    const { data } = await api.delete(`/settings/company/upload/${field}`, {
      data: { changedByName: actorName },
    });
    if (data?.settings) set({ settings: data.settings, loaded: true });
    return data;
  },
}));

export default useCompanySettingsStore;
