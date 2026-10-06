import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// ── Dev/preview backend target ──────────────────────────────────────────────
// Normal development: unchanged — proxy to the standard backend on :5000.
// Preview (PETSHROW_PREVIEW=1, set by .claude/launch.json): the target MUST be
// supplied explicitly via PETSHROW_PROXY_TARGET and may NEVER be the
// production port (5000). A missing/invalid value aborts startup, so the
// preview UI can never silently fall back to — or be pointed at — production.
const PRODUCTION_PORT = '5000';
const isPreview = process.env.PETSHROW_PREVIEW === '1';
let backendTarget = 'http://localhost:' + PRODUCTION_PORT;
if (isPreview) {
  const raw = process.env.PETSHROW_PROXY_TARGET;
  let u = null;
  try { u = new URL(raw); } catch { /* handled below */ }
  const loopback = u && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (!u || !loopback || !u.port || u.port === PRODUCTION_PORT) {
    throw new Error('[preview-safety] PETSHROW_PREVIEW=1 requires PETSHROW_PROXY_TARGET=http://127.0.0.1:<port> on a loopback host with a non-production port (not ' + PRODUCTION_PORT + '). Got: ' + String(raw));
  }
  backendTarget = u.origin;
} else if (process.env.PETSHROW_PROXY_TARGET) {
  backendTarget = process.env.PETSHROW_PROXY_TARGET;
}

export default defineConfig({
  plugins: [react()],
  base: './',   // relative paths so assets load under file:// in Electron
  server: {
    port: 3002,
    strictPort: true,
    proxy: {
      '/api': {
        target: backendTarget,
        changeOrigin: true,
      },
      '/socket.io': {
        target: backendTarget,
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          'ag-grid': ['ag-grid-community', 'ag-grid-react'],
          'charts': ['recharts'],
          'vendor': ['react', 'react-dom', 'react-router-dom', 'axios', 'zustand'],
        },
      },
    },
  },
});
