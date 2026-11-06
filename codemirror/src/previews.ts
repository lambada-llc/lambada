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

import { TO_STRING, expectTests, expectations, type ExpectTest } from './expect';
import { evaluated, programOf, requested, scopeHolder, type Scope } from './evaluations';
import { lambadaCompilations } from './compilation';
import type { Resolved } from './config';
import { Bindings, dagLine, type DagLine } from './dag';
import { treeOf, type Tree, type Value } from './tree';

/** A statement that is an expression, and the whole program that produces it. */
export interface Expression {
  from: number;
  to: number;
  /** Everything above it, plus itself: a document the runtime can evaluate.
   * Empty until it is put together; see `building`. */
  dag: string;
  /**
   * The same, through the `_to_string` the document defines above it, if it
   * does: what an expect test records. Otherwise just `dag`.
   */
  rendered: string;
  /** That `_to_string` definition, or null: the same object for every
   * expression it renders. */
  renderer: { text: string } | null;
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
function expressionsIn(state: EditorState, config: Resolved, before: Walked | null): Walked {
  const context = new Bindings(baseOf(config));
  const base = context.length;
  const marks: { to: number; length: number }[] = [];
  let known = state.doc.length;
  const found: Expression[] = [];
  // The document's own, not the environment's: a test is rendered by the
  // `_to_string` of the file it is in.
  let renderer: Expression['renderer'] = null;
  // An expression's programs are decided by its own text and the statements
  // above it, so they are kept under that chain and asked for again only when
  // it changes — not on every answer a worker brings, nor for every expression
  // when one statement is edited.
  const chains = new Map<string, number>();
  const programs = new Map<number, Programs>();
  const unbuilt: Unbuilt[] = [];
  let next = before?.memo.next ?? 1;
  let chain = 0;

  for (const { statement, state: status } of state.field(config.analyses)) {
    if (status !== 'ok') {
      // Nothing below a statement that did not compile can be evaluated
      // either: its definitions are missing from everything that follows.
      if (status !== 'blocked') {
        known = statement.from;
        break;
      }
      continue;
    }
    const compilation = state.field(lambadaCompilations).get(statement.text);
    if (compilation?.status !== 'ok') continue;
    const link = `${chain}\n${statement.text}`;
    const id = chains.get(link) ?? before?.memo.chains.get(link) ?? next++;
    chains.set(link, id);
    const lines = linesOf(compilation);
    const bare = lines.find(isBare);
    // Only a definition is in the chain: what an expression compiles to beside
    // its value are names of the compiler's, which whatever comes after binds
    // again before it uses them — so editing a test leaves the programs of the
    // tests below it as they were.
    if (!bare) chain = id;
    else {
      const made = before?.memo.programs.get(id);
      if (made) programs.set(id, made);
      else
        unbuilt.push({
          id,
          from: statement.from,
          length: context.length,
          own: lines.filter((line) => !isBare(line)),
          bare,
          rendered: renderer !== null,
        });
      found.push({ from: statement.from, to: statement.to, renderer, ...(made ?? NOT_BUILT) });
    }
    for (const line of lines)
      if (!isBare(line)) {
        context.push(line);
        if (line.name === TO_STRING) renderer = { text: statement.text };
      }
    marks.push({ to: statement.to, length: context.length });
  }
  return {
    expressions: found,
    scope: { lines: context, base, marks, known },
    memo: { chains, programs, next },
    unbuilt,
  };
}

/** An expression whose programs are not put together yet: see `building`. */
interface Unbuilt {
  id: number;
  from: number;
  /** How many of the scope's lines are above it. */
  length: number;
  own: readonly DagLine[];
  bare: DagLine;
  /** Whether a `_to_string` above it reads its value. */
  rendered: boolean;
}

/** The programs of an expression not put together yet: empty, which nothing
 * evaluates, so the expression reads as pending until they are. */
const NOT_BUILT: Programs = { dag: '', rendered: '' };

function programsOf(lines: Bindings, { length, own, bare, rendered }: Unbuilt): Programs {
  const program = (end: readonly DagLine[]) =>
    lines.needed(length, [...own, ...end]).map((line) => line.text).join('\n');
  const dag = program([bare]);
  return {
    dag,
    rendered: rendered ? program([dagLine(`:rendered ${TO_STRING} ${bare.name}`), dagLine(':rendered')]) : dag,
  };
}

/** Programs put together since the walk that found their expressions. */
const built = StateEffect.define<ReadonlyMap<number, Programs>>();

/**
 * Puts together the programs a walk left unbuilt, a slice at a time while the
 * page is idle, those in view first.
 *
 * Not in the walk itself: a program reaches tens of thousands of lines, and an
 * edit to a definition near the top changes every one below it — built in the
 * keystroke, that is a second of typing that does not show. Until it is built
 * an expression is pending, which is what it is.
 */
const building = (field: StateField<Walked>) =>
  ViewPlugin.fromClass(
    class {
      timer: ReturnType<typeof setTimeout> | null = null;

      constructor(readonly view: EditorView) {
        this.schedule();
      }

      update(update: ViewUpdate) {
        if (update.state.field(field) !== update.startState.field(field)) this.schedule();
      }

      schedule() {
        if (this.timer === null && this.view.state.field(field).unbuilt.length)
          this.timer = setTimeout(() => this.slice(), 0);
      }

      slice() {
        this.timer = null;
        const { unbuilt, scope } = this.view.state.field(field);
        const { from, to } = this.view.viewport;
        const shown = (expression: Unbuilt) => (expression.from >= from && expression.from <= to ? 0 : 1);
        const order = [...unbuilt].sort((a, b) => shown(a) - shown(b) || a.from - b.from);
        const done = new Map<number, Programs>();
        const start = performance.now();
        for (const expression of order) {
          done.set(expression.id, programsOf(scope.lines, expression));
          if (performance.now() - start > SLICE) break;
        }
        this.view.dispatch({ effects: built.of(done) });
      }

      destroy() {
        if (this.timer !== null) clearTimeout(this.timer);
      }
    },
  );

/** How long one slice of building may hold the page, in milliseconds. */
const SLICE = 30;

/** The two programs an expression is evaluated as; see `Expression`. */
type Programs = Pick<Expression, 'dag' | 'rendered'>;

/** The document's expressions, the scope they were found in, and what the
 * next walk can reuse. */
interface Walked {
  expressions: readonly Expression[];
  scope: Scope;
  memo: { chains: ReadonlyMap<string, number>; programs: ReadonlyMap<number, Programs>; next: number };
  /** Expressions whose programs are left for `building`. */
  unbuilt: readonly Unbuilt[];
}

/** The prelude and the environment, indexed once per configuration: they are
 * long, and they never change. A compiled chunk refers to the prelude's
 * combinator labels and leaves defining them to whoever assembles a program. */
const bases = new WeakMap<Resolved, Bindings>();
function baseOf(config: Resolved): Bindings {
  let base = bases.get(config);
  if (!base) bases.set(config, (base = new Bindings(null, [...config.prelude, ...config.environment])));
  return base;
}

/** A compilation's lines, read once. */
const read = new WeakMap<object, readonly DagLine[]>();
function linesOf(compilation: { dagLines: readonly string[] }): readonly DagLine[] {
  let lines = read.get(compilation);
  if (!lines) read.set(compilation, (lines = compilation.dagLines.filter((line) => line.trim()).map(dagLine)));
  return lines;
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

// `evaluated` is a worker of its own. Evaluating is unbounded, and a program
// that will not finish must not hold up the compilations that mark the document
// and feed the completions.

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
    wrap.addEventListener('mousedown', (event) => land(view, wrap, event));
    secondary(wrap, () => view.dispatch({ effects: toggle.of(this.dag) }));
    return wrap;
  }
}

/**
 * Lands the cursor where `preview` stands, at the end of its expression, for a
 * plain press — whether on the preview or past it (see `pressPast`). The
 * preview's to do rather than the editor's, which leaves a press inside a
 * widget alone and, on a touch screen, the tap's emulated press too.
 */
function land(view: EditorView, preview: HTMLElement, event: MouseEvent): boolean {
  if (event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey)
    return false;
  event.preventDefault();
  view.dispatch({ selection: { anchor: view.posAtDOM(preview) } });
  view.focus();
  return true;
}

/**
 * A press in the rest of a line, past its preview, is the preview's too. Left
 * to the browser, it is a caret to place beside an element that cannot hold
 * one, at the end of a line — which WebKit gets wrong.
 */
const pressPast = EditorView.domEventHandlers({
  mousedown(event, view) {
    const line = event.target;
    if (!(line instanceof HTMLElement) || !line.classList.contains('cm-line')) return false;
    const preview = line.querySelector<HTMLElement>(':scope > .cm-preview');
    return (
      !!preview &&
      event.clientX >= preview.getBoundingClientRect().right &&
      land(view, preview, event)
    );
  },
});

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
    readonly preview: Inline,
    readonly value: Value,
    readonly dag: string,
  ) {
    super();
  }

  eq(other: Details): boolean {
    return other.preview === this.preview && other.value === this.value && other.dag === this.dag;
  }

  get estimatedHeight(): number {
    return 60;
  }

  toDOM(view: EditorView): HTMLElement {
    const { preview, value } = this;
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
interface Shown {
  /** Null where the host chose to show nothing. */
  preview: Preview | null;
  value: Value;
  /** What the host was told of the test, in short: a change asks again. */
  told: string;
}

/** What of a test the host's choice can turn on, as a key. */
// Not the file: its lines name it by hash already, and its bytes may be many.
const told = (test: ExpectTest | null): string => {
  if (!test) return '';
  const { outcome } = test;
  return JSON.stringify([
    outcome.kind,
    'lines' in outcome ? outcome.lines : null,
    'message' in outcome ? outcome.message : null,
  ]);
};

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
  // One test per expression, in the same order, read off the same list.
  const tests = expectTests(state);
  expressions.forEach((expression, index) => {
    const test = tests?.[index] ?? null;
    if (!expression.dag) return;
    live.add(expression.dag);
    // What was shown for this program is asked for first, and not only to save
    // rebuilding a host's element: a program is its own answer, so a preview
    // once drawn for it stays true, and it outlives the moment between the
    // statements settling and the value being published again.
    let entry = shown.get(expression.dag);
    if (!entry || entry.told !== told(test)) {
      const evaluation = known.get(expression.dag);
      if (evaluation?.status !== 'ok') return;
      entry = { preview: config.preview(treeOf(evaluation), test), value: evaluation, told: told(test) };
      shown.set(expression.dag, entry);
    }
    const { preview } = entry;
    if (!preview) return;
    const at = (widget: Decoration) => builder.add(expression.to, expression.to, widget);
    if (preview.type === 'block') {
      at(
        Decoration.widget({
          side: 1,
          block: true,
          widget: new BlockPreview(preview.element, preview.height_px),
        }),
      );
      return;
    }
    at(Decoration.widget({ side: 1, widget: new InlinePreview(preview, expression.dag) }));
    if (expanded.has(expression.dag))
      at(
        Decoration.widget({
          side: 1,
          block: true,
          widget: new Details(preview, entry.value, expression.dag),
        }),
      );
  });
  for (const dag of shown.keys()) if (!live.has(dag)) shown.delete(dag);
  for (const dag of expanded) if (!live.has(dag)) expanded.delete(dag);
  return { shown, expanded, decorations: builder.finish() };
}

export function previews(config: Resolved): Extension {
  // In the state rather than worked out per reader: the decorations, the
  // evaluations asked for and the evaluations published all want the same list,
  // and finding it means writing out a program per expression.
  // Walked again only when what the statements came to has: an answer from
  // the evaluating worker changes no expression.
  const expressions = StateField.define<Walked>({
    create: (state) => expressionsIn(state, config, null),
    update: (value, tr) => {
      const made = tr.effects.filter((effect) => effect.is(built)).map((effect) => effect.value as ReadonlyMap<number, Programs>);
      if (!made.length && tr.state.field(config.analyses) === tr.startState.field(config.analyses)) return value;
      const programs = new Map(value.memo.programs);
      for (const done of made) for (const [id, program] of done) programs.set(id, program);
      return expressionsIn(tr.state, config, { ...value, memo: { ...value.memo, programs } });
    },
  });

  const decorations = StateField.define<Previews>({
    create: (state) =>
      build(state, config, state.field(expressions).expressions, new Map(), new Set()),
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
      return build(tr.state, config, tr.state.field(expressions).expressions, value.shown, expanded);
    },
    provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
  });

  return [
    evaluated.field,
    expressions,
    scopeHolder.of(expressions),
    building(expressions),
    config.showPreviews ? [theme, pressPast, decorations] : [],
    config.expectTests ? expectations(config.analyses, expressions, evaluated.field) : [],
    evaluated.keep(config, (state) => [
      ...state.field(expressions).expressions.flatMap((expression) =>
        !expression.dag ? [] : config.expectTests ? [expression.dag, expression.rendered] : [expression.dag],
      ),
      ...requested(state).flatMap((request) => {
        const program = programOf(state, request);
        return program.status === 'ok' ? [program.program] : [];
      }),
    ]),
  ];
}
