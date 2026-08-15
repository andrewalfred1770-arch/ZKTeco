// EP-011 — Manager Edition / Mac Standalone Edition: which build this bundle
// is. Baked in at build time by Vite (`vite build --mode manager` loads
// .env.manager → VITE_EDITION=manager; `vite build --mode standalone` loads
// .env.standalone → VITE_EDITION=standalone) — never read at runtime, so
// there is no code path where a Server build can be talked into behaving
// like a Manager or Standalone build.
export const EDITION =
  import.meta.env.VITE_EDITION === 'standalone' ? 'standalone' :
  import.meta.env.VITE_EDITION === 'manager'    ? 'manager' :
  'server';

export const isManager    = EDITION === 'manager';
export const isStandalone = EDITION === 'standalone';
export const isServer     = EDITION === 'server';
