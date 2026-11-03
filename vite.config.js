import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const api = 'http://localhost:3000';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    // Keep every asset a real file: the CSP allows no data: URIs.
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    rolldownOptions: {
      output: {
        // Reviewer-only code is emitted under /private/, which the server serves to signed-in reviewers only.
        chunkFileNames: (chunk) =>
          chunk.facadeModuleId?.replaceAll('\\', '/').includes('/src/private/') ? 'private/[name]-[hash].js' : 'assets/[name]-[hash].js',
      },
    },
  },
  server: {
    proxy: { '/api': api },
  },
});
