import { syntaxTree } from '@codemirror/language';
import type { EditorState, Extension } from '@codemirror/state';
import { linter, type Diagnostic } from '@codemirror/lint';

import type { Problem } from './analysis';
import { lambadaCompilations } from './compilation';
import type { Resolved } from './config';
import type { Statement } from './statements';
import { legible } from './tooltips';

// The message and the tooltip around it both, since a diagnostic is drawn into
// the panel as well as into the hover.
const theme = legible('.cm-tooltip-lint', '.cm-diagnostic');

/**
 * Undefined names, reported where they are written.
 *
 * The compiler names what it could not resolve, but says nothing about where
 * it was: the syntax tree is what turns a name back into a range, so the
 * squiggle lands under the word rather than over the whole statement.
 */
export function diagnostics(config: Resolved): Extension {
  return [
    theme,
    linter(
      (view) =>
        view.state.field(config.analyses).flatMap((analysis) =>
          analysis.problems.map((problem) =>
            locate(view.state, analysis.statement, problem),
          ),
        ),
      {
        // Results arrive from a worker rather than from an edit, so the usual
        // "something changed in the document" is not enough of a signal.
        needsRefresh: (update) =>
          update.startState.field(lambadaCompilations) !==
          update.state.field(lambadaCompilations),
      },
    ),
  ];
}

function locate(
  state: EditorState,
  statement: Statement,
  problem: Problem,
): Diagnostic {
  const at = problem.symbol ? find(state, statement, problem.symbol) : null;
  return {
    from: at ? at.from : statement.from,
    to: at ? at.to : statement.to,
    severity: 'error',
    message: problem.message,
  };
}

/** The first place the name is written in this statement, if it is. */
function find(
  state: EditorState,
  statement: Statement,
  symbol: string,
): { from: number; to: number } | null {
  let found: { from: number; to: number } | null = null;
  syntaxTree(state).iterate({
    from: statement.from,
    to: statement.to,
    enter(node) {
      if (found) return false;
      if (node.name !== 'Identifier' && node.name !== 'Binder') return;
      if (state.doc.sliceString(node.from, node.to) === symbol)
        found = { from: node.from, to: node.to };
      return;
    },
  });
  return found;
}
