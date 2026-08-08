import {
  RangeSetBuilder,
  StateField,
  type EditorState,
  type Extension,
} from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';

import type { StatementState } from './analysis';
import type { Resolved } from './config';

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

/**
 * The marks, and the last thing that could be said about each statement, by its
 * text — kept because a statement stops being answerable for a moment every
 * time one above it is edited.
 */
interface Marks {
  settled: Map<string, StatementState>;
  decorations: DecorationSet;
}

const statusDecorations = (config: Resolved) =>
  StateField.define<Marks>({
    create: (state) => build(state, config, new Map()),
    update: (value, tr) =>
      tr.docChanged || tr.effects.length
        ? build(tr.state, config, value.settled)
        : value,
    provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
  });

function build(
  state: EditorState,
  config: Resolved,
  settled: Map<string, StatementState>,
): Marks {
  const builder = new RangeSetBuilder<Decoration>();
  const live = new Set<string>();
  for (const { statement, state: status } of state.field(config.analyses)) {
    live.add(statement.text);
    if (status === 'ok' || status === 'error') settled.set(statement.text, status);
    // Nothing can be said about a statement below one that is still compiling,
    // and the statement being typed on has no answer yet either. But a
    // statement whose own text has not changed still means what it meant a
    // moment ago, and marking the whole document below the cursor as unknown on
    // every keystroke says far less than leaving it as it was.
    const mark = marks[settled.get(statement.text) ?? status];
    const first = state.doc.lineAt(statement.from).number;
    const last = state.doc.lineAt(statement.to).number;
    for (let n = first; n <= last; n++) {
      const line = state.doc.line(n);
      builder.add(line.from, line.from, mark);
    }
  }
  for (const text of settled.keys()) if (!live.has(text)) settled.delete(text);
  return { settled, decorations: builder.finish() };
}

export const statementStatus = (config: Resolved): Extension => [
  theme,
  statusDecorations(config),
];
