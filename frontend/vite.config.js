import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',   // relative paths so assets load under file:// in Electron
  server: {
    port: 3002,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://localhost:5000',
        changeOrigin: true,
      },
      '/socket.io': {
        target: 'http://localhost:5000',
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
