import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API = `http://127.0.0.1:${process.env.ORBIT_PORT ?? 4310}`;

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: '../dist', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { '/api': { target: API, changeOrigin: false } },
  },
  optimizeDeps: { exclude: ['jassub'] },
});
