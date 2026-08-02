import { defineConfig } from 'vite';
import { lezer } from '@lezer/generator/rollup';

// The library, for hosts that import the package instead of looking at the
// demo. `vite.config.ts` beside this one builds the demo page; they are two
// configs because one Vite build produces one thing, and the demo's `root` and
// `base` are wrong for a library.
export default defineConfig({
  // `src/syntax.grammar` is compiled to a parser at build time here too, so the
  // generated code is never checked in.
  plugins: [lezer()],
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    lib: {
      entry: 'src/index.ts',
      formats: ['es'],
      fileName: () => 'index.js',
    },
    rollupOptions: {
      // The peer dependencies stay imports rather than being bundled: a host
      // that already has CodeMirror must not end up with a second copy of it
      // inside this file. The generated parser is not a dependency — it is this
      // package's own build output — so it goes in.
      external: [
        '@codemirror/language',
        '@codemirror/state',
        '@codemirror/view',
        '@lezer/highlight',
        '@lezer/lr',
      ],
    },
  },
});
