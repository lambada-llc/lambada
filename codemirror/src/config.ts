import type { StateField } from '@codemirror/state';

import { analyses, initialScope, type Analysis } from './analysis';
import { defaultCompiler } from './generated/compiler';
import { defaultPreview, type Preview } from './previews';
import type { Tree } from './tree';

export interface CompileConfig {
  /** The compiler, as a DAG. Defaults to the one this package ships. */
  compiler?: string;
  /** How long one statement may take before its worker is killed. */
  timeout?: number;
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
   */
  previewResults?: boolean | ((value: Tree) => Preview);
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
  timeout: number;
  environment: string;
  /** The names the environment brings into scope, read out of it once. */
  initialScope: ReadonlySet<string>;
  /** What each statement came to, so that every reader gets the same answer. */
  analyses: StateField<readonly Analysis[]>;
  showStatus: boolean;
  showDiagnostics: boolean;
  showCompletions: boolean;
  showPreviews: boolean;
  /** What to show for a value, defaulted to the tree itself. */
  preview: (value: Tree) => Preview;
}

/** The defaults, in one place. `null` is compiling turned off altogether. */
export function resolve(compile: boolean | CompileConfig): Resolved | null {
  if (compile === false) return null;
  const config = compile === true ? {} : compile;
  const environment = config.environment ?? '';
  const scope = initialScope(environment);
  return {
    compiler: config.compiler ?? defaultCompiler,
    timeout: config.timeout ?? 10000,
    environment,
    initialScope: scope,
    analyses: analyses(scope),
    showStatus: config.showStatus !== false,
    showDiagnostics: config.showDiagnostics !== false,
    showCompletions: config.showCompletions !== false,
    // Whether to evaluate at all and what to show for the result are one
    // option to a host and two to everything here.
    showPreviews: config.previewResults !== false,
    preview:
      typeof config.previewResults === 'function' ? config.previewResults : defaultPreview,
  };
}
