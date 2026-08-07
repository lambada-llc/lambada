import { defineConfig } from 'vitest/config';
import { lezer } from '@lezer/generator/rollup';
import { playwright } from '@vitest/browser-playwright';

// Two suites, because the package is two things. What it works out about a
// document — where the statements are, what a value is written as — is state
// and text, and runs in Node. What it puts on the screen, and everything that
// waits on a worker, only exists in a browser, and every bug worth catching so
// far has been on that side: a border that reserved no width, a tooltip
// painted its own colour, a dispatch from inside an update.
const grammar = { plugins: [lezer()] };

export default defineConfig({
  ...grammar,
  test: {
    projects: [
      {
        ...grammar,
        test: {
          name: 'logic',
          environment: 'node',
          include: ['test/*.test.ts'],
        },
      },
      {
        ...grammar,
        // The parser is generated during the run, so its own import is found
        // too late to be pre-bundled with everything else — and a run that
        // discovers a dependency reloads the page it discovered it on, in the
        // middle of whatever test was using it.
        optimizeDeps: { include: ['@lezer/lr'] },
        test: {
          name: 'browser',
          include: ['test/browser/*.test.ts'],
          // One file at a time. Completions only open in a focused editor, and
          // files running side by side are documents competing for one focus;
          // each editor also starts two workers that force the compiler, which
          // is enough work to starve the others.
          fileParallelism: false,
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
});
