import {
  RangeSetBuilder,
  StateField,
  type EditorState,
  type Extension,
} from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';

import { analyze } from './analysis';

// A border rather than a gutter marker: a statement is a run of lines, and one
// border down its left edge reads as one thing where a marker per line does
// not. `oklch` so the three colours sit at the same lightness as each other.
//
// Every line carries the border, transparent until there is something to say.
// Putting it on the marked lines alone would mean a line gained two pixels the
// moment it was first compiled, and the text under the cursor would jump.
const theme = EditorView.baseTheme({
  '.cm-line': { borderLeft: '2px solid transparent' },
  '.cm-statement-pending, .cm-statement-blocked': {
    borderLeftColor: 'color-mix(in srgb, currentColor 25%, transparent)',
  },
  '.cm-statement-ok': { borderLeftColor: 'oklch(70% 0.16 145)' },
  '.cm-statement-error': { borderLeftColor: 'oklch(65% 0.20 25)' },
});

const marks = {
  pending: Decoration.line({ class: 'cm-statement-pending' }),
  blocked: Decoration.line({ class: 'cm-statement-blocked' }),
  ok: Decoration.line({ class: 'cm-statement-ok' }),
  error: Decoration.line({ class: 'cm-statement-error' }),
};

const statusDecorations = (environment: string) =>
  StateField.define<DecorationSet>({
    create: (state) => build(state, environment),
    update: (value, tr) =>
      tr.docChanged || tr.effects.length ? build(tr.state, environment) : value,
    provide: (field) => EditorView.decorations.from(field),
  });

function build(state: EditorState, environment: string): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const { statement, state: status } of analyze(state, environment)) {
    const mark = marks[status];
    const first = state.doc.lineAt(statement.from).number;
    const last = state.doc.lineAt(statement.to).number;
    for (let n = first; n <= last; n++) {
      const line = state.doc.line(n);
      builder.add(line.from, line.from, mark);
    }
  }
  return builder.finish();
}

export const statementStatus = (environment: string): Extension => [
  theme,
  statusDecorations(environment),
];
