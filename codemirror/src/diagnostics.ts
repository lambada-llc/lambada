import { syntaxTree } from '@codemirror/language';
import type { EditorState, Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { linter, type Diagnostic } from '@codemirror/lint';

import { analyze, type Problem } from './analysis';
import { lambadaCompilations } from './compilation';
import type { Statement } from './statements';

/**
 * Undefined names, reported where they are written.
 *
 * The compiler names what it could not resolve, but says nothing about where
 * it was: the syntax tree is what turns a name back into a range, so the
 * squiggle lands under the word rather than over the whole statement.
 */
// The tooltip a diagnostic appears in belongs to whatever theme the host
// loaded, and a theme that picks its background from the wrong end of its own
// palette leaves the message unreadable — dark on dark, or light on light.
// Stating both colours on the diagnostic itself keeps it legible whatever is
// around it. `&light` and `&dark` follow the editor's own theme rather than the
// page's, and a theme that does style diagnostics still wins over a base theme.
const theme = EditorView.baseTheme({
  '&light .cm-tooltip-lint, &light .cm-diagnostic': {
    backgroundColor: '#f5f5f5',
    color: '#1c1c1c',
  },
  '&dark .cm-tooltip-lint, &dark .cm-diagnostic': {
    backgroundColor: '#2b2b2b',
    color: '#eeeeee',
  },
});

export function diagnostics(environment: string): Extension {
  return [
    theme,
    linter(
      (view) =>
        analyze(view.state, environment).flatMap((analysis) =>
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
