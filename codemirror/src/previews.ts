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
  keymap,
  showTooltip,
  WidgetType,
  type DecorationSet,
  type Tooltip,
} from '@codemirror/view';

import { results } from './worker';
import { lambadaCompilations } from './compilation';
import type { Resolved } from './config';
import { dagLine, needed, type DagLine } from './dag';
import { tappable } from './tooltips';
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
 * `copy` is the value as the reader takes it away, from the menu a right-click
 * or a long press on the preview opens — worked out only then, since it may be
 * far longer than what fits on the line. Without it, what is shown is what is
 * copied.
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

/**
 * The default: the tree itself, `△ (△ △) △`, application to the left and cut
 * short past [width]. Nothing is read into it — that is the host's to know,
 * which is also why this is exported: a host that reads only the values it
 * recognises hands the rest back here.
 *
 * The `=` is what keeps the value from reading as more of the program. It is
 * written here rather than by whatever draws the preview, so that a host can
 * write something else. What is copied is the tree alone, and all of it.
 */
export const defaultPreview = (tree: Tree): Preview => ({
  type: 'inline',
  formatted: `= ${written(tree, width)}`,
  copy: () => written(tree, copied),
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
  constructor(readonly preview: Inline) {
    super();
  }

  // The preview itself rather than its text: two values can be shown alike
  // and copy differently. One program keeps one preview, see `shown`.
  eq(other: InlinePreview): boolean {
    return other.preview === this.preview;
  }

  toDOM(view: EditorView): HTMLElement {
    // A span, so it sits at the end of the line the expression is on rather
    // than pushing itself onto one of its own.
    const wrap = document.createElement('span');
    wrap.className = 'cm-preview';
    wrap.setAttribute('aria-hidden', 'true');
    wrap.textContent = this.preview.formatted;
    const { formatted, copy = () => formatted } = this.preview;
    const at = () => view.posAtDOM(wrap);
    // A press lands the cursor where the preview stands, at the end of its
    // expression — the widget's to do rather than the editor's, which leaves
    // a press inside a widget alone and, on a touch screen, the tap's
    // emulated press too.
    wrap.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      view.dispatch({ selection: { anchor: at() } });
      view.focus();
    });
    const offer = () => view.dispatch({ effects: setMenu.of(menuAt(at(), wrap, copy)) });
    wrap.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      offer();
    });
    held(wrap, offer);
    return wrap;
  }
}

/**
 * Calls `then` when a finger rests on `dom`: the long press that is a touch
 * screen's right-click. Some browsers answer it with a `contextmenu` of their
 * own and some do not, and offering twice shows the one menu.
 */
function held(dom: HTMLElement, then: () => void): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let fired = false;
  const cancel = () => clearTimeout(timer);
  dom.addEventListener('touchstart', () => {
    cancel();
    fired = false;
    timer = setTimeout(() => {
      fired = true;
      then();
    }, 500);
  });
  // A finger that moves is scrolling, not holding.
  dom.addEventListener('touchmove', cancel);
  dom.addEventListener('touchcancel', cancel);
  // Letting go after the menu opened is not also a tap: without this, the
  // press the browser makes of it moves the cursor, and the menu goes with it.
  dom.addEventListener('touchend', (event) => {
    cancel();
    if (fired) event.preventDefault();
  });
}

// ── the menu ────────────────────────────────────────────────────────────────

const setMenu = StateEffect.define<Tooltip | null>();

/**
 * What a preview offers: to copy its value. One item, so a button. Placed by
 * the preview rather than by its position in the text, which sits at the
 * preview's near edge and is out of sight when a long line has the editor
 * scrolled sideways, taking the menu with it.
 */
function menuAt(pos: number, preview: HTMLElement, copy: () => string): Tooltip {
  return {
    pos,
    above: true,
    create: (view) => {
      const dom = document.createElement('button');
      dom.type = 'button';
      dom.className = 'cm-preview-menu';
      dom.textContent = 'copy result';
      // Taken on the press, and not the editor's, which would move the cursor
      // and the menu out from under it.
      dom.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        void navigator.clipboard.writeText(copy());
        view.dispatch({ effects: setMenu.of(null) });
      });
      return { dom, getCoords: () => preview.getBoundingClientRect() };
    },
  };
}

/** The menu, open until it is used or anything else happens. */
const menu = StateField.define<Tooltip | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setMenu)) return effect.value;
    return tr.docChanged || tr.selection ? null : value;
  },
  provide: (field) => showTooltip.from(field),
});

const close = (view: EditorView): boolean => {
  if (!view.state.field(menu)) return false;
  view.dispatch({ effects: setMenu.of(null) });
  return true;
};

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
    // A long press is the menu's, not the browser's own callout.
    WebkitTouchCallout: 'none',
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
        ? Decoration.widget({ side: 1, widget: new InlinePreview(value) })
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
    menu,
    tappable('.cm-tooltip.cm-preview-menu'),
    keymap.of([{ key: 'Escape', run: close }]),
    EditorView.domEventHandlers({ blur: (_event, view) => void close(view) }),
    evaluated.field,
    expressions,
    decorations,
    evaluated.keep(config, (state) =>
      state.field(expressions).map((expression) => expression.dag),
    ),
  ];
}
