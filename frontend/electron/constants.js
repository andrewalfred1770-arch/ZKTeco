import { app } from 'electron';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { isStandalone } from './edition.js';

// EF-008 Phase 4: this file now lives in frontend/electron/, one level below
// the original frontend/electron.js. FRONTEND_ROOT recovers the exact same
// absolute directory the original file's `__dirname` resolved to (verified
// live before this split), so every downstream `join(FRONTEND_ROOT, ...)`
// call (icon paths, preload paths, backend entry resolution) produces byte-
// identical paths to before.
const __thisFileDir = dirname(fileURLToPath(import.meta.url));
export const FRONTEND_ROOT = resolve(__thisFileDir, '..');

// ─── Constants ────────────────────────────────────────────────────────────────
export const IS_DEV       = !app.isPackaged;
export const VITE_PORT    = 3002;
// Cross-edition port isolation: Mac Standalone runs its own managed MySQL
// on a non-default port (see mysqlManager.js MYSQL_PORT) specifically so it
// can never collide with a Server-edition install on the same machine — the
// backend HTTP port needs the same guarantee. Without this, a Standalone
// launch defaults to the SAME port as a Windows Production (Server/Manager)
// install, and killStaleBackend()'s taskkill-by-port fallback can then kill
// the real production backend when it mistakes it for a stale process.
// Server/Manager keep the original hardcoded 5000, unchanged.
const DEFAULT_BACKEND_PORT = isStandalone ? 33071 : 5000;
// PETSHROW_TEST_BACKEND_PORT: isolated-test-environment override ONLY — lets
// a throwaway test launch (any edition) bind a different port than a real
// install so it can never collide with an already-running production
// backend. Unset in every real deployment (installer/portable never set
// this env var), so this is byte-identical to DEFAULT_BACKEND_PORT above
// for every actual user.
export const BACKEND_PORT = process.env.PETSHROW_TEST_BACKEND_PORT
  ? Number(process.env.PETSHROW_TEST_BACKEND_PORT)
  : DEFAULT_BACKEND_PORT;
export const APP_NAME     = 'PETSHROW ERP';
// Temporary build marker — bump when re-packaging so Runtime Verification can
// prove the EXE is loading THIS build and not a stale cached app.asar/dist.
// Printed in [Startup Diagnostics] below and surfaced in the renderer console
// + sidebar (see branding.js BRAND.buildMarker / Layout.jsx).
export const BUILD_MARKER = 'BUILD: 2026-08-17-release-1.2.2-version-bump';
export const HEALTH_URL   = `http://localhost:${BACKEND_PORT}/api/health`;
export const FRONTEND_URL = `http://localhost:${VITE_PORT}`;  // dev only

// EP-003 Hybrid Client/Server — API contract version this client build was
// written against. Compared to the backend's /api/health `apiVersion` field
// by the Connection Settings "Test Connection" flow. Independent of both the
// app's package.json version and the backend's — bump only on a real
// API-contract change (must stay in sync with backend/src/apiVersion.js).
export const REQUIRED_API_VERSION = 1;
