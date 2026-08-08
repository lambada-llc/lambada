import {
  RangeSetBuilder,
  StateField,
  type EditorState,
  type Extension,
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  WidgetType,
  type DecorationSet,
} from '@codemirror/view';

import { results } from './worker';
import { lambadaCompilations } from './compilation';
import type { Resolved } from './config';
import { dagLine, needed, type DagLine } from './dag';
import { treeOf, type Tree, type Value } from './tree';

/** A statement that is an expression, and the whole program that produces it. */
interface Expression {
  from: number;
  to: number;
  /** Everything above it, plus itself: a document the runtime can evaluate. */
  dag: string;
}

// The compiler emits references to `__ENV△` and expects it to be the leaf.
// Nothing in the DAG format binds it, so anything evaluated has to say so.
const leafBinding = dagLine('__ENV△ △');

const isBare = (line: DagLine) => line.from.length === 0;

/**
 * The statements that are expressions rather than definitions, each with the
 * program that evaluates it.
 *
 * The compiler ends what it produces with a bare name when the source was an
 * expression, and with nothing when it was a definition — which is how the two
 * are told apart. Carrying an expression forward means dropping that bare name
 * again, since it would end the document before the statements below it.
 *
 * The program is cut down to what the expression actually reaches. That is
 * mostly not an optimisation: a program is remembered by its text, so carrying
 * a definition the expression never looks at means an edit to that definition
 * asks for the same value to be worked out again. Cut down, an expression is
 * only ever recomputed when something it truly depends on changes — and the
 * program is smaller to send and to read, which is the part that is.
 */
function expressionsIn(state: EditorState, config: Resolved): readonly Expression[] {
  const context: DagLine[] = [leafBinding, ...config.environment];
  const found: Expression[] = [];

  for (const { statement, state: status } of state.field(config.analyses)) {
    if (status !== 'ok') {
      // Nothing below a statement that did not compile can be evaluated
      // either: its definitions are missing from everything that follows.
      if (status !== 'blocked') break;
      continue;
    }
    const compilation = state.field(lambadaCompilations).get(statement.text);
    if (compilation?.status !== 'ok') continue;
    const lines = compilation.dagLines.filter((line) => line.trim()).map(dagLine);
    if (lines.some(isBare))
      found.push({
        from: statement.from,
        to: statement.to,
        dag: needed(context.concat(lines))
          .map((line) => line.text)
          .join('\n'),
      });
    // One at a time: a statement can compile to a hundred thousand lines, and
    // spreading that many arguments into `push` overflows the stack.
    for (const line of lines) if (!isBare(line)) context.push(line);
  }
  return found;
}

/**
 * What to show for a value. A block says how much room to keep for it, since
 * the editor places what follows before the element has drawn anything; an
 * element that ends up taller pushes the rest of the document down.
 *
 * An inline preview lands at the end of the line as it stands. Nothing is put
 * in front of it: whatever marks it off from the code is part of what the
 * preview said, so a host that wants no marker, or a different one, is not
 * overruled.
 */
export type Preview =
  | { type: 'inline'; formatted: string }
  | { type: 'block'; element: HTMLElement; height_px: number };

/** How much tree fits at the end of a line of code. */
const width = 40;

/**
 * The default: the tree itself, `△ (△ △) △`, application to the left and cut
 * short past [width]. Nothing is read into it — that is the host's to know,
 * which is also why this is exported: a host that reads only the values it
 * recognises hands the rest back here.
 *
 * The `=` is what keeps the value from reading as more of the program. It is
 * written here rather than by whatever draws the preview, so that a host can
 * write something else.
 */
export const defaultPreview = (tree: Tree): Preview => ({
  type: 'inline',
  formatted: `= ${written(tree)}`,
});

function written(tree: Tree): string {
  const parts: string[] = [];
  let length = 0;
  // Thrown to end the walk once there is more tree than there is room for.
  // What comes after cannot change what has already been written.
  const enough = {};
  const put = (text: string) => {
    parts.push(text);
    length += text.length;
    if (length > width) throw enough;
  };

  // Depth costs a character before it recurses, so [width] bounds the stack.
  const write = (node: Tree, nested: boolean): void => {
    if (node.length === 0) return put('△');
    if (nested) put('(');
    put('△');
    for (const child of node) {
      put(' ');
      write(child, true);
    }
    if (nested) put(')');
  };

  try {
    write(tree, false);
  } catch (error) {
    if (error !== enough) throw error;
    return `${parts.join('').slice(0, width)}…`;
  }
  return parts.join('');
}

// A worker of its own. Evaluating is unbounded, and a program that will not
// finish must not hold up the compilations that mark the document and feed the
// completions.
const evaluated = results<Value>('run');

class InlinePreview extends WidgetType {
  constructor(readonly text: string) {
    super();
  }

  eq(other: InlinePreview): boolean {
    return other.text === this.text;
  }

  toDOM(): HTMLElement {
    // A span, so it sits at the end of the line the expression is on rather
    // than pushing itself onto one of its own.
    const wrap = document.createElement('span');
    wrap.className = 'cm-preview';
    wrap.setAttribute('aria-hidden', 'true');
    wrap.textContent = this.text;
    return wrap;
  }
}

class BlockPreview extends WidgetType {
  constructor(
    readonly element: HTMLElement,
    readonly height: number,
  ) {
    super();
  }

  eq(other: BlockPreview): boolean {
    return other.element === this.element && other.height === this.height;
  }

  /** What the editor lays the rest of the document out against. */
  get estimatedHeight(): number {
    return this.height;
  }

  toDOM(): HTMLElement {
    // Wrapped rather than sized directly: the element belongs to the host.
    // A floor rather than a height, so an element that grows — one that has
    // loaded, or been expanded — moves the code below rather than covering it.
    const wrap = document.createElement('div');
    wrap.className = 'cm-preview-block';
    wrap.style.minHeight = `${this.height}px`;
    wrap.appendChild(this.element);
    return wrap;
  }
}

const theme = EditorView.baseTheme({
  '.cm-preview': {
    paddingLeft: '1ch',
    opacity: '0.6',
    fontStyle: 'italic',
    // It is not part of the document, so it must not look selectable or
    // land in a copy of the text.
    userSelect: 'none',
    // The end of a line is where a click most often means to land, and this
    // sits exactly there. An event inside a widget is one the editor drops,
    // cursor and all, so the click has to reach the line instead.
    pointerEvents: 'none',
  },
});

/**
 * The decorations, and the previews they were built from — kept so a host's
 * element is not rebuilt on every keystroke, and kept here rather than beside
 * the extension so each editor has its own: an element can only be in one
 * document at a time.
 */
interface Previews {
  shown: Map<string, Preview>;
  decorations: DecorationSet;
}

function build(
  state: EditorState,
  config: Resolved,
  expressions: readonly Expression[],
  shown: Map<string, Preview>,
): Previews {
  const builder = new RangeSetBuilder<Decoration>();
  const known = state.field(evaluated.field);
  const live = new Set<string>();
  for (const expression of expressions) {
    live.add(expression.dag);
    // What was shown for this program is asked for first, and not only to save
    // rebuilding a host's element: a program is its own answer, so a preview
    // once drawn for it stays true, and it outlives the moment between the
    // statements settling and the value being published again.
    let value = shown.get(expression.dag);
    if (!value) {
      const evaluation = known.get(expression.dag);
      if (evaluation?.status !== 'ok') continue;
      shown.set(expression.dag, (value = config.preview(treeOf(evaluation))));
    }
    builder.add(
      expression.to,
      expression.to,
      value.type === 'inline'
        ? Decoration.widget({ side: 1, widget: new InlinePreview(value.formatted) })
        : Decoration.widget({
            side: 1,
            block: true,
            widget: new BlockPreview(value.element, value.height_px),
          }),
    );
  }
  for (const dag of shown.keys()) if (!live.has(dag)) shown.delete(dag);
  return { shown, decorations: builder.finish() };
}

export function previews(config: Resolved): Extension {
  // In the state rather than worked out per reader: the decorations, the
  // evaluations asked for and the evaluations published all want the same list,
  // and finding it means writing out a program per expression.
  const expressions = StateField.define<readonly Expression[]>({
    create: (state) => expressionsIn(state, config),
    update: (value, tr) =>
      tr.docChanged || tr.effects.length ? expressionsIn(tr.state, config) : value,
  });

  const decorations = StateField.define<Previews>({
    create: (state) => build(state, config, state.field(expressions), new Map()),
    update: (value, tr) => {
      if (!tr.docChanged && !tr.effects.length) return value;
      // A statement that is still compiling says nothing about what is below
      // it, so there is nothing to draw there — but what is already drawn was
      // true of the text a moment ago and will be true again in a few
      // milliseconds. Carried along rather than taken away and put back, since
      // a preview that blinks on every keystroke is worse than one that is
      // briefly out of date.
      if (tr.state.field(config.analyses).some((a) => a.state === 'pending'))
        return { shown: value.shown, decorations: value.decorations.map(tr.changes) };
      return build(tr.state, config, tr.state.field(expressions), value.shown);
    },
    provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
  });

  return [
    theme,
    evaluated.field,
    expressions,
    decorations,
    evaluated.keep(config, (state) =>
      state.field(expressions).map((expression) => expression.dag),
    ),
  ];
}
