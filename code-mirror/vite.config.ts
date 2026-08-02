import { defineConfig } from 'vite';

// Only the demo page is built for now. When there is a package to publish, a
// library build gets added next to this one rather than replacing it.
export default defineConfig({
  root: 'demo',
  // Relative asset paths, so the output can be served from any subpath.
  base: './',
  build: {
    target: 'es2022',
    outDir: '../demo-dist',
    emptyOutDir: true,
  },
});
