import {
  StateField,
  type EditorState,
  type Extension,
  type Text,
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  GutterMarker,
  ViewPlugin,
  WidgetType,
  lineNumberWidgetMarker,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';

import { highlightingFor } from '@codemirror/language';
import { highlightCode, type Tag } from '@lezer/highlight';

import type { Analysis } from './analysis';
import { lambadaLanguage } from './language';
import type { Expression } from './previews';
import { treeOf, type Tree, type Value } from './tree';
import type { Outcome } from './worker';

// Expect tests, offered rather than written.
//
// A source's bare expressions are its tests, and the build writes what each
// evaluates to back under it as a `# = …` comment. Here the editor works that
// block out as the build would — the same `_to_string`, the same file rule,
// the same layout — and where the text below an expression disagrees, it shows
// the block it would write as a patch. Nothing is written until the reader
// accepts it: an edit the reader did not make is not the editor's to make.

/** What a source defines to say how its expect tests' results read. */
export const TO_STRING = '_to_string';

/** Only these lines are an expect test's; anything else is the author's. */
const HEAD = '# = ';
const TAIL = '#   ';

/** What the build writes for a result, a line at a time. */
function block(result: string): string[] {
  const [first, ...rest] = result.replace(/\n+$/, '').split('\n');
  return [HEAD + first, ...rest.map((line) => TAIL + line)];
}

// ── reading a value ─────────────────────────────────────────────────────────
//
// As the build's runtime reads it, step for step: the whole list first, then
// every element's bits, then the code points — so a value that is not a string
// fails here with the message the build stops with, not merely somewhere.

const failed = (message: string): never => {
  throw new Error(message);
};

function list(tree: Tree): Tree[] {
  const items: Tree[] = [];
  for (; tree.length === 2; tree = tree[1]) items.push(tree[0]);
  return tree.length === 0 ? items : failed('tree is not a list');
}

const bool = (tree: Tree): boolean => (tree.length === 2 ? failed('tree is not a bool') : tree.length === 1);

/** Least significant bit first. */
const nat = (tree: Tree): bigint =>
  list(tree).reduceRight((n, bit) => 2n * n + (bool(bit) ? 1n : 0n), 0n);

/** A code point, refused in the words Node's own refusal uses. */
function character(code: bigint): string {
  const point = Number(code);
  return Number.isInteger(point) && point >= 0 && point <= 0x10ffff
    ? String.fromCodePoint(point)
    : failed(`Invalid code point ${point}`);
}

const text = (tree: Tree): string => list(tree).map(nat).map(character).join('');

/** Deliberately narrow — the build will write nothing else as a file. */
const FILE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.[a-zA-Z0-9]+$/;

/** `△ (△ name media-type) bytes`, read as the build reads it, or null. */
function file(tree: Tree): { name: string; bytes: Uint8Array } | null {
  if (tree.length !== 2 || tree[0].length !== 2) return null;
  try {
    const name = text(tree[0][0]);
    text(tree[0][1]);
    if (name.length > 255 || !FILE_NAME.test(name)) return null;
    return { name, bytes: new Uint8Array(list(tree[1]).map(nat).map(Number)) };
  } catch {
    return null;
  }
}

/** What the build records for a test, and whether that is a file's name and
 * hash rather than the value itself — or why the build stops at it instead. */
type Recorded = { result: string; file: boolean } | { failure: string };

function recorded(raw: Value, rendered: Value): Recorded {
  const written = file(treeOf(raw));
  if (written) return { result: `${written.name} sha256:${sha256(written.bytes)}`, file: true };
  try {
    return { result: text(treeOf(rendered)), file: false };
  } catch (error) {
    // Not a string: the build fails on it, and writes no block anywhere.
    return { failure: (error as Error).message };
  }
}

// SHA-256, because the build names a file's content by it and the editor needs
// the answer in the same transaction that asks — the browser's own is async.
const K = Uint32Array.from(
  '428a2f98 71374491 b5c0fbcf e9b5dba5 3956c25b 59f111f1 923f82a4 ab1c5ed5 d807aa98 12835b01 243185be 550c7dc3 72be5d74 80deb1fe 9bdc06a7 c19bf174 e49b69c1 efbe4786 0fc19dc6 240ca1cc 2de92c6f 4a7484aa 5cb0a9dc 76f988da 983e5152 a831c66d b00327c8 bf597fc7 c6e00bf3 d5a79147 06ca6351 14292967 27b70a85 2e1b2138 4d2c6dfc 53380d13 650a7354 766a0abb 81c2c92e 92722c85 a2bfe8a1 a81a664b c24b8b70 c76c51a3 d192e819 d6990624 f40e3585 106aa070 19a4c116 1e376c08 2748774c 34b0bcb5 391c0cb3 4ed8aa4a 5b9cca4f 682e6ff3 748f82ee 78a5636f 84c87814 8cc70208 90befffa a4506ceb bef9a3f7 c67178f2'
    .split(' ').map((word) => parseInt(word, 16)),
);

function sha256(bytes: Uint8Array): string {
  const bits = bytes.length * 8;
  const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const tail = new DataView(padded.buffer);
  tail.setUint32(padded.length - 8, Math.floor(bits / 2 ** 32));
  tail.setUint32(padded.length - 4, bits >>> 0);

  const h = Uint32Array.of(
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  );
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let at = 0; at < padded.length; at += 64) {
    for (let i = 0; i < 16; i++) w[i] = tail.getUint32(at + 4 * i);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    let [a, b, c, d, e, f, g, k] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = k + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i];
      const t2 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c));
      [k, g, f, e, d, c, b, a] = [g, f, e, (d + t1) | 0, c, b, a, (t1 + t2) | 0];
    }
    [a, b, c, d, e, f, g, k].forEach((x, i) => (h[i] += x));
  }
  return [...h].map((x) => x.toString(16).padStart(8, '0')).join('');
}

// ── patches ─────────────────────────────────────────────────────────────────

/**
 * One thing the build would have written differently, as the changes that write
 * it, the lines it proposes where it proposes them (`side` -1: above the line
 * starting at `at`; 1 or more: below the line ending there), and the lines it
 * replaces.
 */
export interface Patch {
  changes: readonly { from: number; to: number; insert: string }[];
  shown: readonly { at: number; side: number; lines: string }[];
  replaces: { from: number; to: number } | null;
}

/**
 * What the build says about one expression when it writes no block for it:
 * the message it stops with (`fails`), or — where the editor gave up waiting and
 * the build, which has no time limit, would not — why it is not known
 * (`unknown`).
 */
export interface Verdict {
  kind: 'fails' | 'unknown';
  message: string;
  /** The end of the expression's last line, which it is shown under. */
  at: number;
}

/** The `# = …` block under the line ending at `to`, if there is one. */
function blockUnder(doc: Text, to: number): { lines: string[]; from: number; to: number } {
  const end = doc.lineAt(to);
  const lines: string[] = [];
  let last = end;
  for (let n = end.number + 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    if (lines.length ? !line.text.startsWith(TAIL) : !line.text.startsWith(HEAD)) break;
    lines.push(line.text);
    last = line;
  }
  return { lines, from: lines.length ? doc.line(end.number + 1).from : end.to, to: last.to };
}

/**
 * The patch that makes a run of failing tests ones the build can record: a
 * `_to_string` using `render`, above the first of them — and, where later tests
 * are still rendered by the `_to_string` this run was, that definition again
 * after the last, so nothing below changes.
 */
function rendering(
  doc: Text,
  render: string,
  run: readonly Expression[],
  restore: Expression['renderer'] | undefined,
): Patch {
  const first = run[0];
  const above = `${TO_STRING} = ${render}`;
  const changes = [{ from: first.from, to: first.from, insert: `${above}\n` }];
  const shown = [{ at: first.from, side: -1, lines: above }];
  if (restore !== undefined) {
    const again = restore?.text ?? `${TO_STRING} = \\x x`;
    const at = blockUnder(doc, run[run.length - 1].to).to;
    changes.push({ from: at, to: at, insert: `\n${again}` });
    // After the failure said under the last test, which is at its line's end.
    shown.push({ at, side: 2, lines: again });
  }
  return { changes, shown, replaces: null };
}

/**
 * Every expression whose block below disagrees with what it evaluates to, the
 * verdicts on those it has no block for, and the expressions whose value the
 * block cannot say — see `Expectations`.
 *
 * An expression still being evaluated has no patch: what it will come to is
 * not known, and a patch that is a guess would be worse than none. `results`
 * keeps what was read out of each pair of programs, so a value is only read —
 * and a file only hashed — once.
 */
function patches(
  state: EditorState,
  expressions: readonly Expression[],
  known: ReadonlyMap<string, Outcome<Value>>,
  results: Map<string, Recorded>,
  render: string | null,
): Pick<Expectations, 'found' | 'verdicts' | 'unsaid'> {
  const doc = state.doc;
  const found: Patch[] = [];
  const verdicts: Verdict[] = [];
  const unsaid = new Set<string>();
  const live = new Set<string>();
  // Consecutive failing tests under one `_to_string` take one patch between them.
  let run: Expression[] = [];
  const close = (next: number) => {
    if (!run.length || !render) return void (run = []);
    const renderer = run[0].renderer;
    const later = expressions.slice(next).some((expression) => expression.renderer === renderer);
    found.push(rendering(doc, render, run, later ? renderer : undefined));
    run = [];
  };
  expressions.forEach((expression, index) => {
    const { to, dag, rendered } = expression;
    const key = `${dag}\n\n${rendered}`;
    live.add(key);
    const end = doc.lineAt(to);
    if (!results.has(key)) {
      const raw = known.get(dag);
      const shown = known.get(rendered);
      const gaveUp = [raw, shown].find((outcome) => outcome?.status === 'error');
      if (gaveUp?.status === 'error')
        verdicts.push({ kind: 'unknown', message: gaveUp.message, at: end.to });
      if (raw?.status !== 'ok' || shown?.status !== 'ok') return close(index);
      results.set(key, recorded(raw, shown));
    }
    const record = results.get(key)!;
    if ('failure' in record) {
      verdicts.push({ kind: 'fails', message: record.failure, at: end.to });
      if (run.length && run[0].renderer !== expression.renderer) close(index);
      run.push(expression);
      return;
    }
    close(index);
    if (record.file) unsaid.add(dag);

    const lines = block(record.result).join('\n');
    const old = blockUnder(doc, to);
    if (old.lines.join('\n') === lines) return;
    found.push(
      old.lines.length
        ? {
            changes: [{ from: old.from, to: old.to, insert: lines }],
            shown: [{ at: old.to, side: 1, lines }],
            replaces: old,
          }
        : {
            changes: [{ from: end.to, to: end.to, insert: `\n${lines}` }],
            shown: [{ at: end.to, side: 1, lines }],
            replaces: null,
          },
    );
  });
  close(expressions.length);
  for (const key of results.keys()) if (!live.has(key)) results.delete(key);
  return { found, verdicts, unsaid };
}

const accept = (view: EditorView, chosen: readonly Patch[]) =>
  view.dispatch({ changes: chosen.flatMap((patch) => patch.changes) });

/**
 * `text` as the editor would show it were it in the document: a `.cm-line` per
 * line, so the theme indents and sets it as it does every line, and its tokens
 * classed by the language and whichever highlighter the editor has — so a
 * `# = …` block reads as the comment it is, in any theme.
 */
function written(view: EditorView, text: string): HTMLElement[] {
  const highlighter = { style: (tags: readonly Tag[]) => highlightingFor(view.state, tags) };
  const lines: HTMLElement[] = [];
  const next = () => {
    const line = document.createElement('div');
    line.className = 'cm-line';
    lines.push(line);
  };
  next();
  highlightCode(
    text,
    lambadaLanguage.parser.parse(text),
    highlighter,
    (code, classes) => {
      const span = document.createElement('span');
      span.className = classes;
      span.textContent = code;
      lines[lines.length - 1].append(classes ? span : code);
    },
    next,
  );
  return lines;
}

/** A patch, under the block it replaces: the lines it would write, and only
 * those — what accepts it is beside it, in the line-number gutter. */
class Proposed extends WidgetType {
  constructor(readonly lines: string) {
    super();
  }

  eq(other: Proposed): boolean {
    return other.lines === this.lines;
  }

  get estimatedHeight(): number {
    return 20 * this.lines.split('\n').length;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'cm-expect';
    wrap.append(...written(view, this.lines));
    return wrap;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

/** One choice: a symbol, and the words that say what it does. */
interface Choice {
  symbol: string;
  label: string;
  run: () => void;
}

/**
 * Open beside `anchor` until a choice is made, or the reader does anything
 * else: presses elsewhere, types, or scrolls by wheel or finger. Not on every
 * `scroll` event — results landing above it move the layout and fire those too,
 * and the menu must not vanish from under a reader still reaching for it.
 */
function menu(view: EditorView, anchor: HTMLElement, choices: readonly Choice[]): void {
  const dom = document.createElement('div');
  dom.className = 'cm-expect-menu';
  dom.setAttribute('role', 'menu');
  const gestures = ['pointerdown', 'keydown', 'wheel', 'touchmove'] as const;
  const close = () => {
    dom.remove();
    for (const type of gestures) removeEventListener(type, elsewhere, true);
  };
  const elsewhere = (event: Event) => {
    if (!dom.contains(event.target as Node)) close();
  };
  for (const { symbol, label, run } of choices) {
    const item = document.createElement('button');
    item.type = 'button';
    item.setAttribute('role', 'menuitem');
    item.append(Object.assign(document.createElement('span'), { textContent: symbol }), label);
    item.addEventListener('click', () => {
      close();
      run();
    });
    dom.append(item);
  }
  // In the editor's own box, so it goes with the editor rather than staying
  // pinned to the page.
  const at = anchor.getBoundingClientRect();
  const box = view.dom.getBoundingClientRect();
  dom.style.left = `${at.left - box.left}px`;
  dom.style.top = `${at.bottom - box.top}px`;
  view.dom.append(dom);
  for (const type of gestures) addEventListener(type, elsewhere, true);
}

const ACCEPT = '✓';
const ACCEPT_ALL = '✓✓';

/**
 * Beside a patch, in the line-number gutter: ✓ accepts it, and ▾ offers the
 * same with its name spelled out, and accepting every patch in the document.
 *
 * Which patch is looked up when it is pressed, by where the gutter says the
 * widget is, rather than remembered: the editor keeps a marker's DOM for as
 * long as `eq` holds, by when the patch may have moved.
 */
class Accept extends GutterMarker {
  constructor(
    readonly at: number,
    readonly field: StateField<Expectations>,
  ) {
    super();
  }

  eq(other: Accept): boolean {
    return other.at === this.at;
  }

  toDOM(view: EditorView): Node {
    const found = () => view.state.field(this.field).found;
    const one = () =>
      accept(view, found().filter((patch) => patch.shown.some((shown) => shown.at === this.at)));
    const button = (text: string, title: string, run: (dom: HTMLElement) => void) => {
      const dom = document.createElement('button');
      dom.type = 'button';
      dom.textContent = text;
      dom.title = title;
      // A press here is not a press in the document: the cursor stays put.
      dom.addEventListener('mousedown', (event) => event.preventDefault());
      dom.addEventListener('click', () => run(dom));
      return dom;
    };
    const wrap = document.createElement('span');
    wrap.className = 'cm-expect-accept';
    wrap.append(
      button(ACCEPT, 'Accept this result', one),
      button('▾', 'More', (dom) =>
        menu(view, wrap.closest('.cm-gutterElement') ?? dom, [
          { symbol: ACCEPT, label: 'Accept', run: one },
          {
            symbol: ACCEPT_ALL,
            label: `Accept all ${found().length}`,
            run: () => accept(view, found()),
          },
        ]),
      ),
    );
    return wrap;
  }
}

/** A verdict, under its expression, set as a line of the editor's own. */
class Said extends WidgetType {
  constructor(readonly verdict: Pick<Verdict, 'kind' | 'message'>) {
    super();
  }

  eq(other: Said): boolean {
    return other.verdict.kind === this.verdict.kind && other.verdict.message === this.verdict.message;
  }

  toDOM(): HTMLElement {
    const line = document.createElement('div');
    line.className = `cm-line cm-expect-${this.verdict.kind}`;
    line.textContent = this.verdict.message;
    return line;
  }
}

/** Beside a verdict, in the gutter: what kind it is, at a glance. */
class Mark extends GutterMarker {
  constructor(readonly kind: Verdict['kind']) {
    super();
  }

  eq(other: Mark): boolean {
    return other.kind === this.kind;
  }

  toDOM(): Node {
    const mark = document.createElement('span');
    mark.className = `cm-expect-${this.kind}-mark`;
    mark.textContent = this.kind === 'fails' ? '✗' : '…';
    return mark;
  }
}

const replaced = Decoration.line({ class: 'cm-expect-replaced' });

function decorate(
  state: EditorState,
  found: readonly Patch[],
  verdicts: readonly Verdict[],
): DecorationSet {
  const ranges = [
    ...found.flatMap(({ shown, replaces }) => [
      ...(replaces
        ? Array.from(
            { length: state.doc.lineAt(replaces.to).number - state.doc.lineAt(replaces.from).number + 1 },
            (_, i) => replaced.range(state.doc.line(state.doc.lineAt(replaces.from).number + i).from),
          )
        : []),
      ...shown.map(({ at, side, lines }) =>
        Decoration.widget({ side, block: true, widget: new Proposed(lines) }).range(at)),
    ]),
    ...verdicts.map((verdict) =>
      Decoration.widget({ side: 1, block: true, widget: new Said(verdict) }).range(verdict.at)),
  ];
  return Decoration.set(ranges, true);
}

interface Expectations {
  found: readonly Patch[];
  verdicts: readonly Verdict[];
  /**
   * The programs of the expressions whose value the block under them does not
   * say: a file, which it names by hash, or a value it cannot record at all.
   * Every other expression's result is right there in its block — or in the
   * patch for it — so a preview at the end of the line would only repeat it.
   */
  unsaid: ReadonlySet<string>;
  results: Map<string, Recorded>;
  decorations: DecorationSet;
}

/**
 * Where every patch and every place the build fails is, down the editor's
 * right edge, so a long source's are found without scrolling for them; a click
 * goes to one.
 */
const marks = (field: StateField<Expectations>) =>
  ViewPlugin.fromClass(
    class {
      strip: HTMLElement;
      constructor(readonly view: EditorView) {
        this.strip = document.createElement('div');
        this.strip.className = 'cm-expect-marks';
        this.strip.setAttribute('aria-hidden', 'true');
        view.dom.appendChild(this.strip);
        this.draw();
      }

      update(update: ViewUpdate) {
        if (
          update.geometryChanged ||
          update.startState.field(field).decorations !== update.state.field(field).decorations
        )
          this.draw();
      }

      draw() {
        this.view.requestMeasure({
          read: (view) => {
            const height = view.contentHeight || 1;
            return {
              top: view.scrollDOM.offsetTop,
              size: view.scrollDOM.clientHeight,
              at: [
                ...view.state.field(field).found.map((patch) => [patch.shown[0].at, ''] as const),
                ...view.state.field(field).verdicts
                  .filter((verdict) => verdict.kind === 'fails')
                  .map((verdict) => [verdict.at, ' fails'] as const),
              ].map(([pos, kind]) => [pos, kind, view.lineBlockAt(pos).top / height] as const),
            };
          },
          write: ({ top, size, at }) => {
            this.strip.style.top = `${top}px`;
            this.strip.style.height = `${size}px`;
            this.strip.replaceChildren(
              ...at.map(([pos, kind, fraction]) => {
                const mark = document.createElement('div');
                mark.className = `cm-expect-mark${kind}`;
                mark.style.top = `${fraction * 100}%`;
                mark.addEventListener('mousedown', (event) => {
                  event.preventDefault();
                  this.view.dispatch({
                    selection: { anchor: pos },
                    effects: EditorView.scrollIntoView(pos, { y: 'center' }),
                  });
                  this.view.focus();
                });
                return mark;
              }),
            );
          },
        });
      }

      destroy() {
        this.strip.remove();
      }
    },
  );

const theme = EditorView.baseTheme({
  '.cm-expect-replaced': {
    textDecoration: 'line-through',
    backgroundColor: '#e5484d1f',
  },
  // No padding, font or colour of its own: its lines are `.cm-line`s and
  // their tokens are highlighted, so the theme sets them as it sets the code.
  '.cm-expect': { backgroundColor: '#30a46c1f' },
  // One split button across the edge of the line-number gutter: ✓ fills the
  // cell where the number would be, and ▾ hangs past the gutter's edge into
  // the gap before the code — the line-number column has to let it show, and
  // a number never overflows it.
  '.cm-gutter.cm-lineNumbers': { overflow: 'visible' },
  '.cm-expect-accept': { position: 'relative', display: 'block', height: '100%' },
  '.cm-expect-accept button': {
    font: 'inherit',
    lineHeight: 'inherit',
    height: '100%',
    color: '#1a7f4b',
    backgroundColor: '#30a46c2e',
    border: 'none',
    padding: '0',
    cursor: 'pointer',
  },
  '.cm-expect-accept button:first-child': {
    width: '100%',
    borderRadius: '4px 0 0 4px',
    fontWeight: 'bold',
  },
  '.cm-expect-accept button:last-child': {
    position: 'absolute',
    left: '100%',
    top: '0',
    width: '1em',
    borderRadius: '0 4px 4px 0',
    borderLeft: '1px solid #30a46c55',
    fontSize: '80%',
  },
  '.cm-expect-accept button:hover': { backgroundColor: '#30a46c4d' },
  '.cm-expect-menu': {
    position: 'absolute',
    zIndex: '400',
    display: 'flex',
    flexDirection: 'column',
    padding: '3px',
    backgroundColor: 'Canvas',
    color: 'CanvasText',
    border: '1px solid #8886',
    borderRadius: '6px',
    boxShadow: '0 4px 12px #0003',
  },
  '.cm-expect-menu button': {
    display: 'flex',
    gap: '1ch',
    alignItems: 'baseline',
    font: 'inherit',
    color: 'inherit',
    background: 'none',
    border: 'none',
    borderRadius: '4px',
    // A finger's worth to aim at, not a cursor's.
    padding: '6px 10px',
    textAlign: 'left',
    whiteSpace: 'nowrap',
    cursor: 'pointer',
  },
  '.cm-expect-menu button:hover': { backgroundColor: '#30a46c26' },
  // One column for the symbols, as wide as the widest, so the labels line up.
  '.cm-expect-menu button span': { color: '#1a7f4b', fontWeight: 'bold', width: '1.6em' },
  // A verdict is a message, not text the build would write: no comment
  // colouring, and nothing to accept.
  '.cm-expect-fails': { backgroundColor: '#e5484d1f', color: '#c62a2f', fontStyle: 'italic' },
  '.cm-expect-unknown': { opacity: '0.6', fontStyle: 'italic' },
  '.cm-expect-fails-mark': { color: '#c62a2f', fontWeight: 'bold' },
  '.cm-expect-unknown-mark': { opacity: '0.6' },
  '.cm-expect-mark.fails': { backgroundColor: '#e5484d' },
  '.cm-expect-marks': {
    position: 'absolute',
    right: '0',
    width: '6px',
    pointerEvents: 'none',
    zIndex: '300',
  },
  '.cm-expect-mark': {
    position: 'absolute',
    left: '0',
    right: '0',
    height: '4px',
    marginTop: '-2px',
    backgroundColor: '#30a46c',
    borderRadius: '1px',
    pointerEvents: 'auto',
    cursor: 'pointer',
  },
});

/**
 * Patches for every expression whose `# = …` block is not what the build
 * would write, read off `expressions` and the values `evaluated` holds — and
 * which expressions' values the blocks leave unsaid, for the previews to show.
 */
export function expectations(
  analyses: StateField<readonly Analysis[]>,
  expressions: StateField<readonly Expression[]>,
  evaluated: StateField<ReadonlyMap<string, Outcome<Value>>>,
  render: string | null,
): { extension: Extension; unsaid: (state: EditorState) => ReadonlySet<string> } {
  const compute = (state: EditorState, results: Map<string, Recorded>): Expectations => {
    const { found, verdicts, unsaid } =
      patches(state, state.field(expressions), state.field(evaluated), results, render);
    return { found, verdicts, unsaid, results, decorations: decorate(state, found, verdicts) };
  };
  const field: StateField<Expectations> = StateField.define<Expectations>({
    create: (state) => compute(state, new Map()),
    update: (value, tr) => {
      if (!tr.docChanged && !tr.effects.length) return value;
      // While a statement is compiling, which expressions there are is not
      // known; the patches drawn a moment ago are carried along rather than
      // taken away and put back, as the previews are.
      if (tr.state.field(analyses).some((a) => a.state === 'pending'))
        return {
          ...value,
          found: value.found.map(({ changes, shown, replaces }) => ({
            changes: changes.map(({ from, to, insert }) =>
              ({ from: tr.changes.mapPos(from, 1), to: tr.changes.mapPos(to, -1), insert })),
            shown: shown.map((one) => ({ ...one, at: tr.changes.mapPos(one.at, one.side < 0 ? 1 : -1) })),
            replaces: replaces &&
              { from: tr.changes.mapPos(replaces.from, 1), to: tr.changes.mapPos(replaces.to, -1) },
          })),
          verdicts: value.verdicts.map((verdict) => ({ ...verdict, at: tr.changes.mapPos(verdict.at, -1) })),
          decorations: value.decorations.map(tr.changes),
        };
      return compute(tr.state, value.results);
    },
    provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
  });
  return {
    extension: [
      theme,
      field,
      marks(field),
      lineNumberWidgetMarker.of((_, widget, block) =>
        widget instanceof Proposed ? new Accept(block.from, field)
          : widget instanceof Said ? new Mark(widget.verdict.kind)
          : null),
    ],
    unsaid: (state) => state.field(field).unsaid,
  };
}
