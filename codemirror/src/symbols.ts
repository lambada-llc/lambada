import { syntaxTree } from '@codemirror/language';
import { StateField, type EditorState, type Extension } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';

import { lambadaStatements, type Statement } from './statements';

// Occurrences of the symbol under the cursor, highlighted — the *symbol*, not
// the word: a lambda's parameter lights up its own uses and nothing else, and
// a name lights up only the uses that resolve to the same definition, with a
// redefinition starting a new symbol of the same spelling.
//
// This reads the tokens, not the compilation, so it works while a statement
// is still compiling and in editors that never compile at all. It can afford
// to: LambAda has no keywords and its scoping is carried entirely by
// brackets, separators and `\` — a binder's scope runs to the end of the
// enclosing bracket group or element, `$` continues an expression rather
// than ending one, and a definition hides any previous meaning of its name
// from the statements that follow. The walk below is that much understanding
// and no more.

interface Range {
  from: number;
  to: number;
}

interface Token extends Range {
  name: string;
  text: string;
}

/** A binder and every use that resolves to it, binder first. */
interface Binding {
  name: string;
  ranges: Range[];
}

interface Written extends Range {
  name: string;
}

/** What one statement's tokens say about its names. */
interface StatementSymbols {
  /** Every `\x` with its uses. Complete: a binder never crosses a statement. */
  bindings: readonly Binding[];
  /** Uses that no binder catches — references to definitions. */
  free: readonly Written[];
  /**
   * The names this statement defines, where they are written: an
   * assignment's left-hand side, or an ADT declaration's type and
   * constructor names — uppercase is what makes a name a constructor, the
   * language's own rule, so the head being uppercase is what tells the two
   * statement forms apart.
   */
  defines: readonly Written[];
}

const tokenNames = new Set([
  'Identifier', 'Binder', 'Operator', '(', ')', '[', ']', '{', '}',
]);

function tokensOf(state: EditorState, statement: Statement): Token[] {
  const tokens: Token[] = [];
  syntaxTree(state).iterate({
    from: statement.from,
    to: statement.to,
    enter(node) {
      if (!tokenNames.has(node.name)) return;
      tokens.push({
        name: node.name,
        from: node.from,
        to: node.to,
        text: state.doc.sliceString(node.from, node.to),
      });
    },
  });
  return tokens;
}

const uppercase = (name: string) => /^[A-Z]/.test(name);

/**
 * The scope walk. Brackets open a group and close it; `,` `;` `|` and `:`
 * end the element they stand in, taking its binders with them but not the
 * ones from outside the group; `$` and `=` continue. An identifier resolves
 * to the nearest live binder of its name, and to `free` past the last one.
 */
export function statementSymbols(
  state: EditorState,
  statement: Statement,
): StatementSymbols {
  const tokens = tokensOf(state, statement);
  const defines: Written[] = [];
  const bindings: Binding[] = [];
  const live: Binding[] = [];
  const free: Written[] = [];

  let i = 0;
  let adt = false;
  if (tokens[0]?.name === 'Identifier' && tokens[1]?.text === '=') {
    defines.push({ name: tokens[0].text, from: tokens[0].from, to: tokens[0].to });
    adt = uppercase(tokens[0].text);
    i = 2;
  }

  // Each frame remembers how many binders were live when it — or its current
  // element — began, which is what a separator or closing bracket ends.
  const frames = [{ barrier: 0 }];
  const close = (barrier: number) => {
    while (live.length > barrier) bindings.push(live.pop()!);
  };

  for (; i < tokens.length; i++) {
    const token = tokens[i];
    switch (token.name) {
      case '(': case '[': case '{':
        frames.push({ barrier: live.length });
        break;
      case ')': case ']': case '}':
        close(frames[frames.length - 1].barrier);
        if (frames.length > 1) frames.pop();
        break;
      case 'Operator':
        if (',;|:'.includes(token.text)) close(frames[frames.length - 1].barrier);
        break;
      case 'Binder':
        live.push({ name: token.text, ranges: [{ from: token.from, to: token.to }] });
        break;
      case 'Identifier': {
        if (adt && frames.length === 1) {
          // The declaration's own names: constructors are definitions, and a
          // constructor's field names belong to nothing at all.
          const written = { name: token.text, from: token.from, to: token.to };
          if (uppercase(token.text)) defines.push(written);
          else bindings.push({ name: token.text, ranges: [written] });
          break;
        }
        const binder = [...live].reverse().find((b) => b.name === token.text);
        if (binder) binder.ranges.push({ from: token.from, to: token.to });
        else free.push({ name: token.text, from: token.from, to: token.to });
        break;
      }
    }
  }
  close(0);

  return { bindings, free, defines };
}

const within = (pos: number, range: Range) => range.from <= pos && pos <= range.to;

/** The last statement strictly above `below` that defines `name`, if any. */
function definerAbove(
  state: EditorState,
  statements: readonly Statement[],
  below: Statement,
  name: string,
): Statement | null {
  let definer: Statement | null = null;
  for (const statement of statements) {
    if (statement.to >= below.from) break;
    if (!statement.text.includes(name)) continue;
    if (statementSymbols(state, statement).defines.some((d) => d.name === name))
      definer = statement;
  }
  return definer;
}

/**
 * Every range the symbol of the definition `governing` (null: the
 * environment, or nothing at all) covers under the name: the definition's
 * own written name, and each use whose nearest definition above is that one.
 * The defining statement's own right-hand side belongs to the *previous*
 * symbol — a definition hides its name only from the code that follows.
 */
function globalRanges(
  state: EditorState,
  statements: readonly Statement[],
  name: string,
  governing: Statement | null,
): Range[] {
  const ranges: Range[] = [];
  let definer: Statement | null = null;
  for (const statement of statements) {
    if (!statement.text.includes(name)) continue;
    const symbols = statementSymbols(state, statement);
    if (definer === governing)
      for (const use of symbols.free) if (use.name === name) ranges.push(use);
    if (symbols.defines.some((d) => d.name === name)) {
      definer = statement;
      if (statement === governing)
        for (const d of symbols.defines) if (d.name === name) ranges.push(d);
    }
  }
  return ranges;
}

/** The ranges of the symbol written at `pos`, or none. */
export function symbolRanges(state: EditorState, pos: number): readonly Range[] {
  const statements = state.field(lambadaStatements);
  const statement = statements.find((s) => s.from <= pos && pos <= s.to);
  if (!statement) return [];
  const symbols = statementSymbols(state, statement);

  for (const binding of symbols.bindings)
    if (binding.ranges.some((range) => within(pos, range))) return binding.ranges;
  for (const d of symbols.defines)
    if (within(pos, d)) return globalRanges(state, statements, d.name, statement);
  for (const use of symbols.free)
    if (within(pos, use))
      return globalRanges(
        state, statements, use.name,
        definerAbove(state, statements, statement, use.name),
      );
  return [];
}

const occurrence = Decoration.mark({ class: 'cm-occurrence' });

function decorate(state: EditorState): DecorationSet {
  const cursor = state.selection.main;
  // A non-empty selection is selection matching's to answer, not this.
  if (!cursor.empty) return Decoration.none;
  const ranges = [...symbolRanges(state, cursor.head)]
    .sort((a, b) => a.from - b.from || a.to - b.to);
  return Decoration.set(ranges.map((r) => occurrence.range(r.from, r.to)));
}

// Stated on both grounds the way the tooltips are, so the wash stays a wash
// on whichever theme the host loaded.
const theme = EditorView.baseTheme({
  '&light .cm-occurrence': { backgroundColor: 'rgba(90, 130, 210, 0.16)' },
  '&dark .cm-occurrence': { backgroundColor: 'rgba(140, 170, 240, 0.24)' },
});

const highlights = StateField.define<DecorationSet>({
  create: decorate,
  update: (deco, tr) =>
    tr.docChanged || tr.selection ? decorate(tr.state) : deco,
  provide: (field) => EditorView.decorations.from(field),
});

/** Same-symbol occurrence highlighting, at the cursor. */
export function symbolHighlights(): Extension {
  return [highlights, theme];
}
