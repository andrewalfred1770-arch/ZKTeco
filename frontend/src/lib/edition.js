// EP-011 — Manager Edition: which build this bundle is. Baked in at build time
// by Vite (`vite build --mode manager` loads .env.manager, which sets
// VITE_EDITION=manager) — never read at runtime, so there is no code path
// where a Server build can be talked into behaving like a Manager build.
export const EDITION = import.meta.env.VITE_EDITION === 'manager' ? 'manager' : 'server';
export const isManager = EDITION === 'manager';
export const isServer = EDITION === 'server';
