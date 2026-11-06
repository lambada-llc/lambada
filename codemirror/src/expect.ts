import { Facet, StateField, type EditorState, type Extension, type Text } from '@codemirror/state';

import type { Analysis } from './analysis';
import type { Expression } from './previews';
import { treeOf, type Tree, type Value } from './tree';
import type { Outcome } from './worker';

// Expect tests: what the build would write under each bare expression of a
// tested source, or what it would do instead.
//
// A source's bare expressions are its tests, and the build writes what each
// evaluates to back under it as a `# = …` comment. Here that block is worked
// out as the build would — the same `_to_string`, the same file rule, the same
// layout, the same messages when it cannot — and kept in the editor's state for
// the host to read with `expectTests`. What to show of it, and when, is the
// host's: this writes nothing to the document, and draws nothing.

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

/** A file the build writes for a test: what it is called, what it is, and its
 * contents. */
export interface ExpectFile {
  name: string;
  mediaType: string;
  bytes: Uint8Array;
}

/** `△ (△ name media-type) bytes`, read as the build reads it, or null. */
function file(tree: Tree): ExpectFile | null {
  if (tree.length !== 2 || tree[0].length !== 2) return null;
  try {
    const name = text(tree[0][0]);
    const mediaType = text(tree[0][1]);
    if (name.length > 255 || !FILE_NAME.test(name)) return null;
    return { name, mediaType, bytes: new Uint8Array(list(tree[1]).map(nat).map(Number)) };
  } catch {
    return null;
  }
}

/** What the build records for a test, and the file it writes rather than say
 * the value, if it does — or why the build stops at it instead. */
type Recorded = { lines: readonly string[]; file: ExpectFile | null } | { failure: string; tree: Tree };

/**
 * What the build writes under a test whose `_to_string` gave `rendered`: the
 * block, a line at a time — or, where `rendered` is not a string, the message
 * the build stops with instead.
 */
export function recording(
  rendered: Tree,
): { kind: 'recorded'; lines: readonly string[] } | { kind: 'fails'; message: string } {
  try {
    return { kind: 'recorded', lines: block(text(rendered)) };
  } catch (error) {
    // Not a string: the build fails on it, and writes no block anywhere.
    return { kind: 'fails', message: (error as Error).message };
  }
}

function recorded(raw: Value, rendered: Value): Recorded {
  const written = file(treeOf(raw));
  if (written) {
    const { name, mediaType, bytes } = written;
    return { lines: block(`${name} ${mediaType} ${bytes.length} bytes sha256:${sha256(bytes)}`), file: written };
  }
  const tree = treeOf(rendered);
  const read = recording(tree);
  return read.kind === 'recorded' ? { lines: read.lines, file: null } : { failure: read.message, tree };
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

// ── what the build would do ─────────────────────────────────────────────────

/** What the build makes of one test. */
export type ExpectOutcome =
  /** Not evaluated yet. */
  | { kind: 'pending' }
  /** The editor gave up on it, and `message` says why. The build has no time
   * limit, so this is the editor's, not the build's. */
  | { kind: 'unknown'; message: string }
  /** The build stops here, with this message: `tree`, what `_to_string`
   * made of the value, is not a string. */
  | { kind: 'fails'; message: string; tree: Tree }
  /**
   * The block the build writes, a line at a time; the file it writes, where
   * the block describes one rather than saying the value; and, where the
   * document has something else there, the edit that writes it.
   */
  | {
      kind: 'recorded';
      lines: readonly string[];
      file: ExpectFile | null;
      edit: { from: number; to: number; insert: string } | null;
    };

/** One test of a tested source, and what the build makes of it. */
export interface ExpectTest {
  /** The expression: the start of its first line, the end of its last. */
  from: number;
  to: number;
  /** The `# = …` block under it as the document has it — empty, at `to`, if
   * there is none. */
  block: { from: number; to: number; lines: readonly string[] };
  /** The `_to_string` definition its result is read through, or null for
   * none: one object per definition, shared by every test it reads. */
  renderer: { text: string } | null;
  outcome: ExpectOutcome;
}

/** The `# = …` block under the line ending at `to`, if there is one. */
function blockUnder(doc: Text, to: number): ExpectTest['block'] {
  const end = doc.lineAt(to);
  const lines: string[] = [];
  let last = end;
  for (let n = end.number + 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    if (lines.length ? !line.text.startsWith(TAIL) : !line.text.startsWith(HEAD)) break;
    lines.push(line.text);
    last = line;
  }
  return { from: lines.length ? doc.line(end.number + 1).from : end.to, to: last.to, lines };
}

/**
 * Every test, and what the build makes of it. `results` keeps what was read
 * out of each test's programs, so a value is only read — and a file only
 * hashed — once.
 */
function tests(
  doc: Text,
  expressions: readonly Expression[],
  known: ReadonlyMap<string, Outcome<Value>>,
  results: Map<string, Recorded>,
): readonly ExpectTest[] {
  const live = new Set<string>();
  const found = expressions.map(({ from, to, dag, rendered, renderer }): ExpectTest => {
    // The program through `_to_string` holds the one without, so it decides
    // both values. Not the two joined: a program runs to megabytes, and the
    // string kept here is hashed once, where a fresh one would be every time.
    const key = rendered;
    live.add(key);
    const under = blockUnder(doc, to);
    const test = (outcome: ExpectOutcome) => ({ from, to, block: under, renderer, outcome });
    if (!key) return test({ kind: 'pending' });
    if (!results.has(key)) {
      const raw = known.get(dag);
      const shown = known.get(rendered);
      const gaveUp = [raw, shown].find((outcome) => outcome?.status === 'error');
      if (gaveUp?.status === 'error') return test({ kind: 'unknown', message: gaveUp.message });
      if (raw?.status !== 'ok' || shown?.status !== 'ok') return test({ kind: 'pending' });
      results.set(key, recorded(raw, shown));
    }
    const record = results.get(key)!;
    if ('failure' in record) return test({ kind: 'fails', message: record.failure, tree: record.tree });
    const { lines } = record;
    const insert = lines.join('\n');
    // A block replaces the one under the expression, or goes in on a line of
    // its own straight after it.
    const edit = under.lines.join('\n') === insert ? null
      : under.lines.length ? { from: under.from, to: under.to, insert }
      : { from: to, to, insert: `\n${insert}` };
    return test({ kind: 'recorded', lines, file: record.file, edit });
  });
  for (const key of results.keys()) if (!live.has(key)) results.delete(key);
  return found;
}

/** Which field holds the tests, if this editor has one. */
const holder = Facet.define<StateField<Held>, StateField<Held> | null>({
  combine: (fields) => fields[0] ?? null,
});

interface Held {
  tests: readonly ExpectTest[];
  results: Map<string, Recorded>;
}

/**
 * Every test of the document and what the build makes of it, in document
 * order — or null where `expectTests` is off. Read it from a host's own state
 * field or view plugin to decide what to show; a new array means something
 * changed.
 */
export function expectTests(state: EditorState): readonly ExpectTest[] | null {
  const field = state.facet(holder);
  return field && state.field(field).tests;
}

/** The tests, kept up to date from `expressions` and the values `evaluated` holds. */
export function expectations(
  analyses: StateField<readonly Analysis[]>,
  expressions: StateField<{ expressions: readonly Expression[] }>,
  evaluated: StateField<ReadonlyMap<string, Outcome<Value>>>,
): Extension {
  const compute = (state: EditorState, results: Map<string, Recorded>): Held => ({
    tests: tests(state.doc, state.field(expressions).expressions, state.field(evaluated), results),
    results,
  });
  const field: StateField<Held> = StateField.define<Held>({
    create: (state) => compute(state, new Map()),
    update: (value, tr) => {
      if (!tr.docChanged && !tr.effects.length) return value;
      // While a statement is compiling, which expressions there are is not
      // known; the tests of a moment ago are carried along, mapped, rather than
      // taken away and put back.
      if (!tr.state.field(analyses).some((a) => a.state === 'pending'))
        return compute(tr.state, value.results);
      if (!tr.docChanged) return value;
      const at = (pos: number, assoc: number) => tr.changes.mapPos(pos, assoc);
      return {
        ...value,
        tests: value.tests.map((test) => ({
          ...test,
          from: at(test.from, 1),
          to: at(test.to, -1),
          block: { ...test.block, from: at(test.block.from, 1), to: at(test.block.to, -1) },
          outcome: test.outcome.kind === 'recorded' && test.outcome.edit
            ? { ...test.outcome, edit: { ...test.outcome.edit, from: at(test.outcome.edit.from, 1), to: at(test.outcome.edit.to, -1) } }
            : test.outcome,
        })),
      };
    },
  });
  return [field, holder.of(field)];
}
