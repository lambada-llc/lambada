import type { StateField } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

import { analyses, initialScope, type Analysis } from './analysis';
import { dagLines, type DagLine } from './dag';
import { defaultCompiler } from './generated/compiler';
import { defaultPreview, type Preview } from './previews';
import type { Tree } from './tree';

export interface GotoDefinitionConfig {
  /**
   * Where a name the *environment* defines is defined, as the action that
   * goes there — or null, where the host has nowhere to send the reader.
   * Asked before a jump is so much as offered (the underline, the pointer),
   * so it has to be cheap; the action itself runs on the click or key that
   * took the offer. Names the document defines never reach this: those jump
   * within the editor on their own.
   *
   * Nothing by default, which leaves every environment name unofferable.
   */
  external?: (name: string) => ((view: EditorView) => void) | null;
  /** Keys that jump at the cursor, in CodeMirror's notation. Default: F12. */
  keys?: readonly string[];
}

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
   * Jump to a name's definition, on modifier-click and on a key. Default:
   * true, which jumps within the document; where a name the environment
   * defines should go is the host's to say — see [GotoDefinitionConfig].
   * `false` offers no jumps at all.
   *
   * It lives here because the spans that say what a click refers to are the
   * compiler's answer: without a compilation there is nothing to resolve.
   */
  gotoDefinition?: boolean | GotoDefinitionConfig;
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
  /** What to show for a value, defaulted to the tree itself. */
  preview: (value: Tree) => Preview;
  /** Go to definition, with its defaults filled in; null is off. */
  goto: {
    external: NonNullable<GotoDefinitionConfig['external']>;
    keys: readonly string[];
  } | null;
}

/** The defaults, in one place. `null` is compiling turned off altogether. */
export function resolve(compile: boolean | CompileConfig): Resolved | null {
  if (compile === false) return null;
  const config = compile === true ? {} : compile;
  const environment = dagLines(config.environment ?? '');
  const scope = initialScope(environment);
  const goto = config.gotoDefinition ?? true;
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
    goto:
      goto === false
        ? null
        : {
            external: (goto === true ? null : goto.external) ?? (() => null),
            keys: (goto === true ? null : goto.keys) ?? ['F12'],
          },
  };
}
