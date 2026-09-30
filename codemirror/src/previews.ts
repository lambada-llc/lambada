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
  // The prelude first: a compiled chunk refers to the combinator labels and
  // leaves defining them to whoever assembles what gets evaluated.
  const context: DagLine[] = [...config.prelude, ...config.environment];
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
 *
 * A right-click or a long press on an inline preview expands it: more of the
 * value, what it is made of, and the tree to copy. `copy` is the value as the
 * host would have it taken away as well — worked out only then, since it may
 * be far longer than what fits on the line.
 */
type Inline = { type: 'inline'; formatted: string; copy?: () => string };
export type Preview =
  | Inline
  | { type: 'block'; element: HTMLElement; height_px: number };

/** How much tree fits at the end of a line of code. */
const width = 40;

/** How much tree is copied: a shared subtree is written out as often as it is
 * used, so a small value can stand for more text than there is memory. */
const copied = 1_000_000;

/** How much of the value an expanded preview shows. */
const excerpt = 400;

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
  formatted: `= ${written(tree, width)}`,
});

/** `tree` as it is written, cut short past `limit` characters. */
function written(tree: Tree, limit: number): string {
  let text = '';
  // What is left to write, next last: text, or a tree and whether it is nested.
  // A list rather than the call stack, which a value as deep as a long string
  // would overflow.
  const pending: (string | readonly [Tree, boolean])[] = [[tree, false]];
  while (pending.length && text.length <= limit) {
    const next = pending.pop()!;
    if (typeof next === 'string') {
      text += next;
      continue;
    }
    const [node, nested] = next;
    if (node.length === 0) {
      text += '△';
      continue;
    }
    text += nested ? '(△' : '△';
    if (nested) pending.push(')');
    for (let i = node.length - 1; i >= 0; i--) pending.push([node[i], true], ' ');
  }
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

// A worker of its own. Evaluating is unbounded, and a program that will not
// finish must not hold up the compilations that mark the document and feed the
// completions.
const evaluated = results<Value>('run');

class InlinePreview extends WidgetType {
  constructor(
    readonly preview: Inline,
    readonly dag: string,
  ) {
    super();
  }

  eq(other: InlinePreview): boolean {
    return other.preview === this.preview && other.dag === this.dag;
  }

  toDOM(view: EditorView): HTMLElement {
    // A span, so it sits at the end of the line the expression is on rather
    // than pushing itself onto one of its own.
    const wrap = document.createElement('span');
    wrap.className = 'cm-preview';
    wrap.setAttribute('aria-hidden', 'true');
    wrap.textContent = this.preview.formatted;
    // A press lands the cursor where the preview stands, at the end of its
    // expression — the widget's to do rather than the editor's, which leaves
    // a press inside a widget alone and, on a touch screen, the tap's
    // emulated press too.
    wrap.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      view.dispatch({ selection: { anchor: view.posAtDOM(wrap) } });
      view.focus();
    });
    secondary(wrap, () => view.dispatch({ effects: toggle.of(this.dag) }));
    return wrap;
  }
}

/**
 * Calls `then` on a right-click, or when a finger rests on `dom` — the long
 * press that is a touch screen's right-click. Some browsers answer a long press
 * with a `contextmenu` of their own and some do not; either way, one press is
 * one call.
 */
function secondary(dom: HTMLElement, then: () => void): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let touching = false;
  let fired = false;
  const cancel = () => clearTimeout(timer);
  const fire = () => {
    cancel();
    if (touching && fired) return;
    fired = true;
    then();
  };
  dom.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    fire();
  });
  dom.addEventListener('touchstart', () => {
    touching = true;
    fired = false;
    cancel();
    timer = setTimeout(fire, 500);
  });
  // A finger that moves is scrolling, not holding.
  dom.addEventListener('touchmove', cancel);
  dom.addEventListener('touchcancel', () => {
    cancel();
    touching = false;
  });
  // Letting go after a long press is not also a tap: without this, the press
  // the browser makes of it would move the cursor.
  dom.addEventListener('touchend', (event) => {
    cancel();
    touching = false;
    if (fired) event.preventDefault();
  });
}

// ── expanded ────────────────────────────────────────────────────────────────

/** Expands an expression's preview, or folds it back — by program, see
 * `Expression`. */
const toggle = StateEffect.define<string>();

/** The tree's size written out, and as held: a shared subtree counts once per
 * use in the first and once in the second. Children come before parents in a
 * `Value`, so one pass sizes them all. */
function sizes({ nodes, root }: Value): { total: bigint; distinct: number } {
  const size: bigint[] = [];
  for (let i = 0; i < nodes.length; i += 2)
    size.push(1n + (size[nodes[i]] ?? 0n) + (size[nodes[i + 1]] ?? 0n));
  return { total: size[root], distinct: nodes.length / 2 };
}

/** An expanded preview, under its expression: more of the value, what it is
 * made of, and the copying. */
class Details extends WidgetType {
  constructor(
    readonly shown: Shown<Inline>,
    readonly dag: string,
  ) {
    super();
  }

  eq(other: Details): boolean {
    return other.shown === this.shown && other.dag === this.dag;
  }

  get estimatedHeight(): number {
    return 60;
  }

  toDOM(view: EditorView): HTMLElement {
    const { preview, value } = this.shown;
    const tree = () => written(treeOf(value), copied);
    const { copy } = preview;
    const text = (copy ?? tree)();

    const excerpted = document.createElement('div');
    excerpted.className = 'cm-preview-excerpt';
    excerpted.textContent = text.length > excerpt ? `${text.slice(0, excerpt)}…` : text;

    const button = (label: string, run: () => void) => {
      const dom = document.createElement('button');
      dom.type = 'button';
      dom.textContent = label;
      dom.addEventListener('click', run);
      return dom;
    };
    const copying = (get: () => string) => () => void navigator.clipboard.writeText(get());
    const { total, distinct } = sizes(value);
    const facts = document.createElement('div');
    facts.className = 'cm-preview-facts';
    facts.append(
      [
        `${total.toLocaleString()} nodes`,
        `${distinct.toLocaleString()} distinct`,
        `${value.steps.toLocaleString()} steps`,
      ].join(' · '),
      ...(copy ? [button('copy value', copying(copy))] : []),
      button('copy tree', copying(tree)),
      button('×', () => view.dispatch({ effects: toggle.of(this.dag) })),
    );

    const wrap = document.createElement('div');
    wrap.className = 'cm-preview-details';
    wrap.append(excerpted, facts);
    inView(wrap);
    return wrap;
  }
}

/**
 * Keeps a block where the reader is looking: as wide as the editor shows, and
 * there however far a long line has the code scrolled sideways.
 *
 * A block widget lives in `.cm-content`, which is as wide as the longest line,
 * so every ancestor it has is too wide to size it by; what is visible is the
 * scroller beside the gutter, and that has to be measured. Zero wide until it
 * is — a guess must not reach the code's layout, and the observer delivers
 * before the first paint.
 */
function inView(element: HTMLElement): void {
  element.style.width = '0';
  element.style.position = 'sticky';
  const placed = new ResizeObserver(() => {
    const scroller = element.closest('.cm-scroller');
    if (!scroller) return;
    placed.disconnect();
    const gutters = scroller.querySelector('.cm-gutters');
    const sizes = new ResizeObserver(() => {
      if (!element.isConnected) return sizes.disconnect();
      const gutter = gutters?.clientWidth ?? 0;
      element.style.left = `${gutter}px`;
      element.style.width = `${scroller.clientWidth - gutter}px`;
    });
    sizes.observe(scroller);
    if (gutters) sizes.observe(gutters);
  });
  placed.observe(element);
}

// Keyed by the wrap rather than kept on the widget, because `destroy` is
// handed the DOM: the editor can make a widget's DOM again after discarding
// it, and the old wrap's watcher must not take the new one's with it.
const watchers = new WeakMap<HTMLElement, ResizeObserver>();

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
    // Floored at the estimate, and the floor holds the room only until the
    // content takes it — while the element has no height of its own, it keeps
    // the document from reflowing under the reader; at the first report of a
    // real box it comes down, and from then on the element speaks for itself,
    // both ways: growing moves the code below rather than covering it, and
    // settling smaller than the guess leaves no dead space. A report of no
    // height — not laid out yet, or detached — settles nothing.
    const wrap = document.createElement('div');
    wrap.className = 'cm-preview-block';
    wrap.style.minHeight = `${this.height}px`;
    wrap.appendChild(this.element);
    const watcher = new ResizeObserver((entries) => {
      if (!entries.some((entry) => entry.contentRect.height > 0)) return;
      wrap.style.minHeight = '';
      watcher.disconnect();
    });
    watcher.observe(this.element);
    watchers.set(wrap, watcher);
    return wrap;
  }

  destroy(dom: HTMLElement): void {
    watchers.get(dom)?.disconnect();
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
    // A long press expands the preview, rather than opening the browser's
    // own callout.
    WebkitTouchCallout: 'none',
  },
  '.cm-preview-details': {
    boxSizing: 'border-box',
    padding: '.2rem 1ch .4rem',
    fontSize: '90%',
  },
  '.cm-preview-excerpt': {
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
  },
  '.cm-preview-facts': {
    opacity: '0.7',
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    gap: '.4rem 1ch',
  },
  '.cm-preview-facts button': {
    font: 'inherit',
    color: 'inherit',
    background: 'none',
    border: '1px solid #8884',
    borderRadius: '4px',
    padding: '0 6px',
    cursor: 'pointer',
  },
});

/** What was shown for a program, and the value it was shown for. */
interface Shown<P extends Preview = Preview> {
  preview: P;
  value: Value;
}

/**
 * The decorations, the previews they were built from, and which of those are
 * expanded — kept so a host's element is not rebuilt on every keystroke, and
 * kept here rather than beside the extension so each editor has its own: an
 * element can only be in one document at a time.
 */
interface Previews {
  shown: Map<string, Shown>;
  expanded: Set<string>;
  decorations: DecorationSet;
}

function build(
  state: EditorState,
  config: Resolved,
  expressions: readonly Expression[],
  shown: Map<string, Shown>,
  expanded: Set<string>,
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
    let entry = shown.get(expression.dag);
    if (!entry) {
      const evaluation = known.get(expression.dag);
      if (evaluation?.status !== 'ok') continue;
      entry = { preview: config.preview(treeOf(evaluation)), value: evaluation };
      shown.set(expression.dag, entry);
    }
    const { preview } = entry;
    const at = (widget: Decoration) => builder.add(expression.to, expression.to, widget);
    if (preview.type === 'block') {
      at(
        Decoration.widget({
          side: 1,
          block: true,
          widget: new BlockPreview(preview.element, preview.height_px),
        }),
      );
      continue;
    }
    at(Decoration.widget({ side: 1, widget: new InlinePreview(preview, expression.dag) }));
    if (expanded.has(expression.dag))
      at(
        Decoration.widget({
          side: 1,
          block: true,
          widget: new Details(entry as Shown<Inline>, expression.dag),
        }),
      );
  }
  for (const dag of shown.keys()) if (!live.has(dag)) shown.delete(dag);
  for (const dag of expanded) if (!live.has(dag)) expanded.delete(dag);
  return { shown, expanded, decorations: builder.finish() };
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
    create: (state) =>
      build(state, config, state.field(expressions), new Map(), new Set()),
    update: (value, tr) => {
      if (!tr.docChanged && !tr.effects.length) return value;
      const expanded = new Set(value.expanded);
      for (const effect of tr.effects)
        if (effect.is(toggle) && !expanded.delete(effect.value)) expanded.add(effect.value);
      // A statement that is still compiling says nothing about what is below
      // it, so there is nothing to draw there — but what is already drawn was
      // true of the text a moment ago and will be true again in a few
      // milliseconds. Carried along rather than taken away and put back, since
      // a preview that blinks on every keystroke is worse than one that is
      // briefly out of date.
      if (tr.state.field(config.analyses).some((a) => a.state === 'pending'))
        return { ...value, expanded, decorations: value.decorations.map(tr.changes) };
      return build(tr.state, config, tr.state.field(expressions), value.shown, expanded);
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
