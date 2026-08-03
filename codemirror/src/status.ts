import {
  RangeSetBuilder,
  StateField,
  type EditorState,
  type Extension,
} from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';

import { lambadaCompilations } from './compilation';
import { lambadaStatements } from './statements';

// A border rather than a gutter marker: a statement is a run of lines, and one
// border down its left edge reads as one thing where a marker per line does
// not. `oklch` so the three colours sit at the same lightness as each other.
//
// Every line carries the border, transparent until there is something to say.
// Putting it on the marked lines alone would mean a line gained two pixels the
// moment it was first compiled, and the text under the cursor would jump.
const theme = EditorView.baseTheme({
  '.cm-line': { borderLeft: '2px solid transparent' },
  '.cm-statement-pending': {
    borderLeftColor: 'color-mix(in srgb, currentColor 25%, transparent)',
  },
  '.cm-statement-ok': { borderLeftColor: 'oklch(70% 0.16 145)' },
  '.cm-statement-error': { borderLeftColor: 'oklch(65% 0.20 25)' },
});

const marks = {
  pending: Decoration.line({ class: 'cm-statement-pending' }),
  ok: Decoration.line({ class: 'cm-statement-ok' }),
  error: Decoration.line({ class: 'cm-statement-error' }),
};

const statusDecorations = StateField.define<DecorationSet>({
  create: (state) => build(state),
  update: (value, tr) => (tr.docChanged || tr.effects.length ? build(tr.state) : value),
  provide: (field) => EditorView.decorations.from(field),
});

function build(state: EditorState): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const compilations = state.field(lambadaCompilations);
  for (const statement of state.field(lambadaStatements)) {
    const known = compilations.get(statement.text);
    // Nothing at all rather than a mark meaning "waiting": when there is no
    // compiler to be had, a border that never resolves would keep promising
    // one.
    if (!known) continue;
    const mark = marks[known.status];
    const first = state.doc.lineAt(statement.from).number;
    const last = state.doc.lineAt(statement.to).number;
    for (let n = first; n <= last; n++) {
      const line = state.doc.line(n);
      builder.add(line.from, line.from, mark);
    }
  }
  return builder.finish();
}

export const statementStatus = (): Extension => [theme, statusDecorations];
