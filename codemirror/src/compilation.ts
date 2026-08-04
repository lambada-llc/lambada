import { StateEffect, StateField, type Extension } from '@codemirror/state';
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';

import { Compiler, type Compilation } from './compile';
import { defaultCompiler } from './generated/compiler';
import { lambadaStatements } from './statements';

export type { Compilation };

/** Carries results from the worker into the state, keyed by statement text. */
const setCompilations = StateEffect.define<ReadonlyMap<string, Compilation>>();

/**
 * What is known about each statement, keyed by its text rather than its
 * position — so an edit above a statement does not throw away its result, and
 * two statements that read the same are compiled once.
 */
export const lambadaCompilations = StateField.define<ReadonlyMap<string, Compilation>>({
  create: () => new Map(),
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setCompilations)) return effect.value;
    return value;
  },
});

export interface CompileConfig {
  /** The compiler, as a DAG. Defaults to the one this package ships. */
  compiler?: string;
  /** How long one statement may take before its worker is killed. */
  timeout?: number;
  /**
   * Mark each statement with how its compilation went. Default: true. Lives
   * here rather than beside `compile` because there is nothing to show without
   * a compiler to show it from.
   */
  showStatus?: boolean;
  /**
   * Report names a statement uses that nothing has defined. Default: true.
   */
  showDiagnostics?: boolean;
  /**
   * Evaluate each statement that is an expression rather than a definition,
   * and show what it comes to. Default: true. It runs on a worker of its own,
   * because evaluating is unbounded and must not hold up the compiling that
   * marks the document.
   */
  showPreviews?: boolean;
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

export function compilation({
  compiler = defaultCompiler,
  timeout = 10000,
}: CompileConfig = {}): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      compiler: Compiler<{ dagLines: readonly string[]; steps: number }>;
      queued = false;
      dead = false;

      constructor(readonly view: EditorView) {
        this.compiler = new Compiler<{ dagLines: readonly string[]; steps: number }>(
          compiler,
          timeout,
          () => this.schedule(),
        );
        this.sync();
      }

      update(update: ViewUpdate) {
        if (update.docChanged) this.sync();
      }

      /** Ask for anything not yet asked for, and forget what is gone. */
      sync() {
        const wanted = new Set(
          this.view.state.field(lambadaStatements).map((s) => s.text),
        );
        this.compiler.retain(wanted);
        for (const text of wanted) this.compiler.request(text);
        this.schedule();
      }

      /**
       * Never dispatches where it is called from. A plugin is constructed and
       * updated inside an update, and starting another one there throws — and
       * a worker that fails to start reports it early enough to land inside
       * that same update, so a microtask is not late enough to help.
       */
      schedule() {
        if (this.queued || this.dead) return;
        this.queued = true;
        setTimeout(() => {
          this.queued = false;
          if (!this.dead) this.publish();
        }, 0);
      }

      publish() {
        const next = new Map<string, Compilation>();
        for (const { text } of this.view.state.field(lambadaStatements)) {
          const value = this.compiler.get(text);
          if (value) next.set(text, value);
        }
        if (same(next, this.view.state.field(lambadaCompilations))) return;
        this.view.dispatch({ effects: setCompilations.of(next) });
      }

      destroy() {
        this.dead = true;
        this.compiler.destroy();
      }
    },
  );

  return [lambadaCompilations, plugin];
}

function same(
  a: ReadonlyMap<string, Compilation>,
  b: ReadonlyMap<string, Compilation>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    const other = b.get(key);
    if (!other || other.status !== value.status) return false;
  }
  return true;
}
