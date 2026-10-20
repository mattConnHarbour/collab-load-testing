import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  build: { sourcemap: true },
  server: {
    proxy: {
      '/api': process.env.API_INTERNAL_ORIGIN ?? 'http://localhost:8100',
      '/collaboration': { target: process.env.API_INTERNAL_ORIGIN ?? 'http://localhost:8100', ws: true },
    },
  },
});
