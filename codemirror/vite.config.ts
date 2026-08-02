import { defineConfig } from 'vite';
import { lezer } from '@lezer/generator/rollup';

// The demo page. The library it demonstrates is built by `vite.lib.config.ts`
// beside this one; `npm run build` runs both.
export default defineConfig({
  root: 'demo',
  // `src/syntax.grammar` is compiled to a parser at build time, so the
  // generated code is never checked in.
  plugins: [lezer()],
  // Relative asset paths, so the output can be served from any subpath.
  base: './',
  build: {
    target: 'es2022',
    outDir: '../demo-dist',
    emptyOutDir: true,
  },
});
