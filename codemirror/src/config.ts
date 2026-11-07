import type { StateField } from '@codemirror/state';

import { analyses, initialScope, type Analysis } from './analysis';
import { dagLines, type DagLine } from './dag';
import { defaultCompiler, defaultPrelude } from './generated/compiler';
import type { ExpectTest } from './expect';
import { defaultPreview, type Preview } from './previews';
import type { Tree } from './tree';

export interface CompileConfig {
  /** The compiler, as a DAG. Defaults to the one this package ships. */
  compiler?: string;
  /**
   * The combinator definitions a compiled chunk refers to, as DAG lines. They
   * belong to the compiler that emits those references, so a host passing its
   * own `compiler` passes its prelude too. Defaults to the pair this package
   * ships.
   */
  prelude?: string;
  /** How long one statement may take to compile before its worker is
   * killed, in milliseconds. */
  timeout?: number;
  /**
   * How long one expression may take to evaluate, in milliseconds; null for
   * as long as it takes. Defaults to `timeout`. Either way, an evaluation can
   * be stopped (`stopEvaluating`), and one nothing wants any more is.
   */
  evaluationTimeout?: number | null;
  /** Mark each statement with how its compilation went. Default: true. */
  showStatus?: boolean;
  /**
   * Report names a statement uses that nothing has defined. Default: true.
   */
  showDiagnostics?: boolean;
  /**
   * Evaluate each statement that is an expression rather than a definition and
   * preview what it came out as. Default: true, which writes the tree itself —
   * e.g. `△ (△ △) △`.
   *
   * On a worker of its own: evaluating is unbounded and must not hold up the
   * compiling that marks the document.
   *
   * A function is handed the value and, with `expectTests` on, the expression's
   * test — what the build makes of it — and may return null to show nothing:
   * a result its `# = …` block already says need not be said twice.
   */
  previewResults?: boolean | ((value: Tree, test: ExpectTest | null) => Preview | null);
  /**
   * Work out each bare expression's expect test the way the build does — the
   * `# = …` block it would write, or the message it would stop with — and keep
   * it for the host to read with `expectTests(state)`. What to show of it is
   * the host's. Default: false: most documents are not tested sources.
   */
  expectTests?: boolean;
  /**
   * Offer the names in scope as completions. Default: true. Which names those
   * are depends on what the statements above compiled to, which is why this
   * lives here.
   */
  showCompletions?: boolean;
  /**
   * What is in scope before the document starts, as a DAG module — see
   * https://github.com/lambada-llc/tree-calculus/blob/main/conventions/README.md#dag-modules
   *
   * Empty by default: `△` is the only bound symbol.
   */
  environment?: string;
}

/**
 * The same configuration with every default filled in, which is what the
 * extensions are handed. Each of them would otherwise have to fill in the ones
 * it reads, and two of them read the same ones.
 */
export interface Resolved {
  compiler: string;
  /** The prelude's lines, read once: it goes in front of everything evaluated. */
  prelude: readonly DagLine[];
  timeout: number;
  evaluationTimeout: number | null;
  /** The environment's lines, read once: it is long and it never changes. */
  environment: readonly DagLine[];
  /** The names the environment brings into scope. */
  initialScope: ReadonlySet<string>;
  /** What each statement came to, so that every reader gets the same answer. */
  analyses: StateField<readonly Analysis[]>;
  showStatus: boolean;
  showDiagnostics: boolean;
  showCompletions: boolean;
  showPreviews: boolean;
  expectTests: boolean;
  /** What to show for a value, defaulted to the tree itself. */
  preview: (value: Tree, test: ExpectTest | null) => Preview | null;
}

/** The defaults, in one place. `null` is compiling turned off altogether. */
export function resolve(compile: boolean | CompileConfig): Resolved | null {
  if (compile === false) return null;
  const config = compile === true ? {} : compile;
  const prelude = dagLines(config.prelude ?? defaultPrelude);
  const environment = dagLines(config.environment ?? '');
  const scope = initialScope(environment);
  return {
    compiler: config.compiler ?? defaultCompiler,
    prelude,
    timeout: config.timeout ?? 10000,
    evaluationTimeout: config.evaluationTimeout === undefined ? config.timeout ?? 10000 : config.evaluationTimeout,
    environment,
    initialScope: scope,
    // Compiled code refers to the prelude's combinator labels, so they are
    // defined as far as a statement is concerned. No source can spell one,
    // which is why they stay out of the scope completions offer.
    analyses: analyses(new Set([...initialScope(prelude), ...scope])),
    showStatus: config.showStatus !== false,
    showDiagnostics: config.showDiagnostics !== false,
    showCompletions: config.showCompletions !== false,
    // Whether to evaluate at all and what to show for the result are one
    // option to a host and two to everything here.
    showPreviews: config.previewResults !== false,
    expectTests: config.expectTests === true,
    preview:
      typeof config.previewResults === 'function' ? config.previewResults : defaultPreview,
  };
}
