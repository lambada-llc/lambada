import {
  RangeSetBuilder,
  StateField,
  type EditorState,
  type Extension,
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

/** Only these lines are an expect test's; anything else is the author's. */
const HEAD = '# = ';
const TAIL = '#   ';

/** What the build writes for a result, a line at a time. */
function block(result: string): string[] {
  const [first, ...rest] = result.replace(/\n+$/, '').split('\n');
  return [HEAD + first, ...rest.map((line) => TAIL + line)];
}

// ── reading a value ─────────────────────────────────────────────────────────

const fail = (what: string): never => {
  throw new Error(`not ${what}`);
};

function list(tree: Tree): Tree[] {
  const items: Tree[] = [];
  for (; tree.length === 2; tree = tree[1]) items.push(tree[0]);
  return tree.length === 0 ? items : fail('a list');
}

/** Least significant bit first; a bit is the leaf or a stem. */
const nat = (tree: Tree): number =>
  list(tree).reduceRight((n, bit) => 2 * n + (bit.length === 2 ? fail('a bit') : bit.length), 0);

// A character at a time: a long string spread into one call overflows the stack.
const text = (tree: Tree): string => list(tree).map((c) => String.fromCodePoint(nat(c))).join('');

/** Deliberately narrow — the build will write nothing else as a file. */
const FILE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.[a-zA-Z0-9]+$/;

/** `△ (△ name media-type) bytes`, read as the build reads it, or null. */
function file(tree: Tree): { name: string; bytes: Uint8Array } | null {
  if (tree.length !== 2 || tree[0].length !== 2) return null;
  try {
    const name = text(tree[0][0]);
    text(tree[0][1]);
    if (name.length > 255 || !FILE_NAME.test(name)) return null;
    return { name, bytes: new Uint8Array(list(tree[1]).map(nat)) };
  } catch {
    return null;
  }
}

/** What the build records for a test, and whether that is a file's name and
 * hash rather than the value itself. */
interface Recorded {
  result: string;
  file: boolean;
}

function recorded(raw: Value, rendered: Value): Recorded | null {
  const written = file(treeOf(raw));
  if (written) return { result: `${written.name} sha256:${sha256(written.bytes)}`, file: true };
  try {
    return { result: text(treeOf(rendered)), file: false };
  } catch {
    // Not a string: the build would fail on it, so there is no block to offer.
    return null;
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

/** One block the build would write differently, as the change that writes it. */
export interface Patch {
  from: number;
  to: number;
  insert: string;
  /** The lines the build would write. */
  lines: readonly string[];
  /** Where the block goes: the end of the expression's last line, or of the
   * block it replaces. */
  at: number;
}

/**
 * Every expression whose block below disagrees with what it evaluates to, and
 * the expressions whose value the block cannot say — see `Expectations`.
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
  results: Map<string, Recorded | null>,
): Pick<Expectations, 'found' | 'unsaid'> {
  const doc = state.doc;
  const found: Patch[] = [];
  const unsaid = new Set<string>();
  const live = new Set<string>();
  for (const { to, dag, rendered } of expressions) {
    const key = `${dag}\n\n${rendered}`;
    live.add(key);
    const raw = known.get(dag);
    if (!results.has(key)) {
      const shown = known.get(rendered);
      if (raw?.status === 'ok' && shown?.status === 'error') unsaid.add(dag);
      if (raw?.status !== 'ok' || shown?.status !== 'ok') continue;
      results.set(key, recorded(raw, shown));
    }
    const record = results.get(key);
    if (!record || record.file) unsaid.add(dag);
    if (!record) continue;

    const lines = block(record.result);
    const end = doc.lineAt(to);
    const old: string[] = [];
    let last = end;
    for (let n = end.number + 1; n <= doc.lines; n++) {
      const line = doc.line(n);
      if (old.length ? !line.text.startsWith(TAIL) : !line.text.startsWith(HEAD)) break;
      old.push(line.text);
      last = line;
    }
    if (old.join('\n') === lines.join('\n')) continue;
    found.push(
      old.length
        ? { from: doc.line(end.number + 1).from, to: last.to, insert: lines.join('\n'), lines, at: last.to }
        : { from: end.to, to: end.to, insert: `\n${lines.join('\n')}`, lines, at: end.to },
    );
  }
  for (const key of results.keys()) if (!live.has(key)) results.delete(key);
  return { found, unsaid };
}

const accept = (view: EditorView, chosen: readonly Patch[]) =>
  view.dispatch({ changes: chosen.map(({ from, to, insert }) => ({ from, to, insert })) });

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

/** Open beside `anchor` until a choice is made, or anything else happens. */
function menu(view: EditorView, anchor: HTMLElement, choices: readonly Choice[]): void {
  const dom = document.createElement('div');
  dom.className = 'cm-expect-menu';
  dom.setAttribute('role', 'menu');
  const close = () => {
    dom.remove();
    removeEventListener('pointerdown', outside, true);
    removeEventListener('keydown', escape, true);
    view.scrollDOM.removeEventListener('scroll', close);
  };
  const outside = (event: Event) => {
    if (!dom.contains(event.target as Node)) close();
  };
  const escape = (event: KeyboardEvent) => {
    if (event.key === 'Escape') close();
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
  // In the editor's own box, so it scrolls away with nothing left behind: a
  // scroll closes it rather than leaving it pinned beside a line now elsewhere.
  const at = anchor.getBoundingClientRect();
  const box = view.dom.getBoundingClientRect();
  dom.style.left = `${at.left - box.left}px`;
  dom.style.top = `${at.bottom - box.top}px`;
  view.dom.append(dom);
  addEventListener('pointerdown', outside, true);
  addEventListener('keydown', escape, true);
  view.scrollDOM.addEventListener('scroll', close);
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
    const one = () => accept(view, found().filter((patch) => patch.at === this.at));
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

const replaced = Decoration.line({ class: 'cm-expect-replaced' });

function decorate(state: EditorState, found: readonly Patch[]): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const patch of found) {
    if (patch.to > patch.from)
      for (let n = state.doc.lineAt(patch.from).number; n <= state.doc.lineAt(patch.to).number; n++)
        builder.add(state.doc.line(n).from, state.doc.line(n).from, replaced);
    builder.add(
      patch.at,
      patch.at,
      Decoration.widget({
        side: 1,
        block: true,
        widget: new Proposed(patch.lines.join('\n')),
      }),
    );
  }
  return builder.finish();
}

interface Expectations {
  found: readonly Patch[];
  /**
   * The programs of the expressions whose value the block under them does not
   * say: a file, which it names by hash, or a value it cannot record at all.
   * Every other expression's result is right there in its block — or in the
   * patch for it — so a preview at the end of the line would only repeat it.
   */
  unsaid: ReadonlySet<string>;
  results: Map<string, Recorded | null>;
  decorations: DecorationSet;
}

/**
 * Where every patch is, down the editor's right edge, so a long source's are
 * found without scrolling for them; a click goes to one.
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
          update.startState.field(field).found !== update.state.field(field).found
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
              at: view.state
                .field(field)
                .found.map((patch) => [patch.from, view.lineBlockAt(patch.from).top / height] as const),
            };
          },
          write: ({ top, size, at }) => {
            this.strip.style.top = `${top}px`;
            this.strip.style.height = `${size}px`;
            this.strip.replaceChildren(
              ...at.map(([pos, fraction]) => {
                const mark = document.createElement('div');
                mark.className = 'cm-expect-mark';
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
): { extension: Extension; unsaid: (state: EditorState) => ReadonlySet<string> } {
  const compute = (state: EditorState, results: Map<string, Recorded | null>): Expectations => {
    const { found, unsaid } =
      patches(state, state.field(expressions), state.field(evaluated), results);
    return { found, unsaid, results, decorations: decorate(state, found) };
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
          found: value.found.map((patch) => ({
            ...patch,
            from: tr.changes.mapPos(patch.from, 1),
            to: tr.changes.mapPos(patch.to, -1),
            at: tr.changes.mapPos(patch.at, -1),
          })),
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
        widget instanceof Proposed ? new Accept(block.from, field) : null),
    ],
    unsaid: (state) => state.field(field).unsaid,
  };
}
