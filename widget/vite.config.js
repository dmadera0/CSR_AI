import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  plugins: [react()],
  build: {
    // ... rest stays the same
    // ── Library mode ─────────────────────────────────────────────
    // Vite bundles everything into a single file and wraps it in an
    // IIFE (Immediately-Invoked Function Expression). The bundle is
    // assigned to window.DemoChat so callers can do:
    //   DemoChat.init({ apiUrl: '...', tenantId: '...' })
    lib: {
      entry: 'src/index.jsx',
      name: 'DemoChat',         // → window.DemoChat
      fileName: () => 'demo-widget',
      formats: ['iife'],        // single self-executing script
    },

    rollupOptions: {
      output: {
        // Do NOT externalize React. Bundle everything into one file so
        // the customer just needs a single <script> tag — no separate
        // React CDN tags required.
        inlineDynamicImports: true,
      },
    },

    outDir: 'dist',
    emptyOutDir: true,

    // Use esbuild for minification (fast, produces small output).
    minify: 'esbuild',

    // Target modern browsers (ES2020). Avoids large polyfill overhead.
    // 95%+ of browsers in 2024+ support this.
    target: 'es2020',
  },
});
