import {
  RangeSetBuilder,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';

import { analyze } from './analysis';
import { Compiler, treeOf, type Evaluation, type Tree, type Value } from './compile';
import { lambadaCompilations, type CompileConfig } from './compilation';
import { defaultCompiler } from './generated/compiler';

/** A statement that is an expression, and the whole program that produces it. */
interface Expression {
  from: number;
  to: number;
  /** Everything above it, plus itself: a document the runtime can evaluate. */
  dag: string;
}

// The compiler emits references to `__ENV△` and expects it to be the leaf.
// Nothing in the DAG format binds it, so anything evaluated has to say so.
const leafBinding = '__ENV△ △';

const isBare = (line: string) => line.trim().split(' ').length === 1;

/**
 * The statements that are expressions rather than definitions, each with the
 * program that evaluates it.
 *
 * The compiler ends what it produces with a bare name when the source was an
 * expression, and with nothing when it was a definition — which is how the two
 * are told apart. Carrying an expression forward means dropping that bare name
 * again, since it would end the document before the statements below it.
 */
function expressionsIn(state: EditorState, environment: string): readonly Expression[] {
  const context: string[] = [leafBinding];
  if (environment.trim()) context.push(environment.trim());
  const found: Expression[] = [];

  for (const { statement, state: status } of analyze(state, environment)) {
    if (status !== 'ok') {
      // Nothing below a statement that did not compile can be evaluated
      // either: its definitions are missing from everything that follows.
      if (status !== 'blocked') break;
      continue;
    }
    const compilation = state.field(lambadaCompilations).get(statement.text);
    if (compilation?.status !== 'ok') continue;
    const lines = compilation.dagLines.filter((line) => line.trim());
    const bare = lines.filter(isBare);
    if (bare.length)
      found.push({
        from: statement.from,
        to: statement.to,
        dag: context.concat(lines).join('\n'),
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
 */
export type Preview =
  | { type: 'inline'; formatted: string }
  | { type: 'block'; element: HTMLElement; height_px: number };

/** How much tree fits at the end of a line of code. */
const width = 40;

/**
 * The default: the tree itself, `△ (△ △) △`, application to the left and cut
 * short past [width]. Nothing is read into it — that is the host's to know.
 */
const asTree = (tree: Tree): Preview => ({ type: 'inline', formatted: written(tree) });

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

const setEvaluations = StateEffect.define<ReadonlyMap<string, Evaluation>>();

const evaluations = StateField.define<ReadonlyMap<string, Evaluation>>({
  create: () => new Map(),
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setEvaluations)) return effect.value;
    return value;
  },
});

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

const previewDecorations = (environment: string, preview: (value: Tree) => Preview) =>
  StateField.define<Previews>({
    create: (state) => build(state, environment, preview, new Map()),
    update: (value, tr) =>
      tr.docChanged || tr.effects.length
        ? build(tr.state, environment, preview, value.shown)
        : value,
    provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
  });

function build(
  state: EditorState,
  environment: string,
  preview: (value: Tree) => Preview,
  shown: Map<string, Preview>,
): Previews {
  const builder = new RangeSetBuilder<Decoration>();
  const known = state.field(evaluations);
  const live = new Set<string>();
  for (const expression of expressionsIn(state, environment)) {
    const evaluation = known.get(expression.dag);
    if (evaluation?.status !== 'ok') continue;
    live.add(expression.dag);
    let value = shown.get(expression.dag);
    if (!value) shown.set(expression.dag, (value = preview(treeOf(evaluation))));
    builder.add(
      expression.to,
      expression.to,
      value.type === 'inline'
        ? // An `=` so the value does not read as more of the program.
          Decoration.widget({ side: 1, widget: new InlinePreview(`= ${value.formatted}`) })
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

export function previews(
  environment: string,
  { compiler = defaultCompiler, timeout = 10000, previewResults = true }: CompileConfig,
): Extension {
  const preview = typeof previewResults === 'function' ? previewResults : asTree;

  const plugin = ViewPlugin.fromClass(
    class {
      runner: Compiler<Value>;
      queued = false;
      dead = false;

      constructor(readonly view: EditorView) {
        // A worker of its own. Evaluating is unbounded, and a program that
        // will not finish must not hold up the compilations that mark the
        // document and feed the completions.
        this.runner = new Compiler<Value>(compiler, timeout, () => this.schedule(), 'run');
        this.sync();
      }

      update(update: ViewUpdate) {
        if (update.docChanged || update.transactions.some((tr) => tr.effects.length))
          this.sync();
      }

      sync() {
        const wanted = new Set(
          expressionsIn(this.view.state, environment).map((e) => e.dag),
        );
        this.runner.retain(wanted);
        for (const dag of wanted) this.runner.request(dag);
        this.schedule();
      }

      // As with compilations: never dispatch from inside an update.
      schedule() {
        if (this.queued || this.dead) return;
        this.queued = true;
        setTimeout(() => {
          this.queued = false;
          if (!this.dead) this.publish();
        }, 0);
      }

      publish() {
        const next = new Map<string, Evaluation>();
        for (const { dag } of expressionsIn(this.view.state, environment)) {
          const value = this.runner.get(dag);
          if (value) next.set(dag, value);
        }
        if (same(next, this.view.state.field(evaluations))) return;
        this.view.dispatch({ effects: setEvaluations.of(next) });
      }

      destroy() {
        this.dead = true;
        this.runner.destroy();
      }
    },
  );

  return [theme, evaluations, previewDecorations(environment, preview), plugin];
}

function same(
  a: ReadonlyMap<string, Evaluation>,
  b: ReadonlyMap<string, Evaluation>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    const other = b.get(key);
    if (!other || other.status !== value.status) return false;
  }
  return true;
}
