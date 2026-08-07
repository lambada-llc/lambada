// What a tree stands for, guessed from its shape.
//
// The package writes the tree itself and reads nothing into it, because what a
// value means is the host's to say. This is one host's answer: the conventions
// the compiler's own literals follow, read back off the result. `△` is false
// and `△ △` is true; a list is nested forks ending in the leaf; a natural is a
// list of bits, least significant first; a string is a list of code points;
// and a file is its name and media type, paired, paired with its contents.
//
// A guess, and it can be wrong — two booleans in a list are also the number
// they spell. Nothing here can tell those apart, because nothing in the value
// says which was meant.

import { defaultPreview, type Preview, type Tree } from '../src/index';

/**
 * How much tree a guess may walk.
 *
 * A value is a DAG: a node reached twice is one node, so a few hundred of them
 * can stand for more nodes than a browser will ever visit. Reading one as a
 * number or a string walks the tree it stands for, so the walk is bounded —
 * and whatever runs out of budget was not a number anybody wanted printed.
 *
 * One counter for the whole guess rather than one per step of it, so that a
 * list of a million lists cannot cost a million times the limit. Safe as a
 * variable because a guess runs to the end without yielding.
 */
const budget = 1 << 20;
let left = 0;
const step = () => left-- > 0;

/** The elements of a list, or `null` if it is not one. */
function items(tree: Tree): Tree[] | null {
  const elements: Tree[] = [];
  let node = tree;
  while (node.length !== 0) {
    if (node.length !== 2 || !step()) return null;
    elements.push(node[0]);
    node = node[1];
  }
  return elements;
}

const isBit = (tree: Tree): boolean =>
  tree.length === 0 || (tree.length === 1 && tree[0].length === 0);

function nat(tree: Tree): bigint | null {
  const bits = items(tree);
  if (!bits) return null;
  let value = 0n;
  for (let i = bits.length - 1; i >= 0; i--) {
    const bit = bits[i];
    if (!isBit(bit)) return null;
    value = value * 2n + (bit.length ? 1n : 0n);
  }
  return value;
}

/**
 * The text a list of code points spells, or `null`.
 *
 * Only what somebody would have written as text: every list of small naturals
 * is a string by the convention, and `[3, 0, 'x']` printed as one says less
 * about itself than its tree does.
 */
function text(tree: Tree): string | null {
  const codes = items(tree);
  if (!codes) return null;
  const characters: string[] = [];
  for (const code of codes) {
    const value = nat(code);
    if (value === null || value > 0x10ffffn) return null;
    const point = Number(value);
    // A surrogate is not a character on its own, and a control character is
    // not something anybody typed into a literal — bar the ones ending a line.
    if (point >= 0xd800 && point <= 0xdfff) return null;
    if (point < 0x20 && point !== 0x09 && point !== 0x0a && point !== 0x0d) return null;
    if (point === 0x7f) return null;
    characters.push(String.fromCodePoint(point));
  }
  return characters.join('');
}

interface FileValue {
  name: string;
  mediaType: string;
  content: string;
}

function file(tree: Tree): FileValue | null {
  if (tree.length !== 2) return null;
  const [head, body] = tree;
  if (head.length !== 2) return null;
  const name = text(head[0]);
  const mediaType = text(head[1]);
  const content = text(body);
  if (name === null || mediaType === null || content === null) return null;
  // The media type is the whole of the guess: without it this is a pair of a
  // pair of strings and a string, which any three strings would answer to.
  return /^[\w.+-]+\/[\w.+-]+$/.test(mediaType) ? { name, mediaType, content } : null;
}

/** How much text fits at the end of a line of code. */
const width = 40;

// Nothing is written around a preview but what it writes itself, so the marker
// is this file's to choose. The same `=` the package writes for a tree, for
// every guess — including the one it falls back to: which guess it was is the
// setting's to say, not something to be read off the punctuation.
const inline = (formatted: string): Preview => ({
  type: 'inline',
  formatted: `= ${formatted}`,
});

// A window on the file rather than a box the width of the pane: nothing here
// knows what shape the contents want, and a square favours none of them.
// Whatever does not fit scrolls inside it.
const frameSize = 260;
const captionHeight = 24;

/**
 * A file, in a frame of its own — the browser already knows how to draw an
 * SVG, and a page cannot say it better in words.
 *
 * As a `data:` URL rather than a `blob:` one, because nothing here is told
 * when a preview stops being shown, and a blob nobody revokes is a leak. The
 * frame is sandboxed into an origin of its own: this is the output of a
 * program somebody is in the middle of writing.
 */
function frame({ name, mediaType, content }: FileValue): Preview {
  const wrap = document.createElement('div');
  wrap.style.padding = '0.2rem 0 0.4rem';

  const caption = document.createElement('div');
  caption.textContent = `${name} — ${mediaType}`;
  caption.style.opacity = '0.6';
  caption.style.lineHeight = `${captionHeight}px`;
  caption.style.overflow = 'hidden';
  caption.style.textOverflow = 'ellipsis';
  caption.style.whiteSpace = 'nowrap';

  const view = document.createElement('iframe');
  view.src = `data:${mediaType};charset=utf-8,${encodeURIComponent(content)}`;
  view.title = name;
  view.setAttribute('sandbox', '');
  view.style.display = 'block';
  view.style.width = `min(100%, ${frameSize}px)`;
  view.style.height = `${frameSize}px`;
  view.style.border = '1px solid currentColor';
  view.style.borderRadius = '4px';
  // The file decides what it is drawn on, and a document with no background
  // of its own would otherwise take the editor's.
  view.style.background = 'white';

  wrap.append(caption, view);
  return { type: 'block', element: wrap, height_px: frameSize + captionHeight + 12 };
}

/** What the value looks like, or the tree when it looks like nothing. */
export function inferred(tree: Tree): Preview {
  left = budget;
  const asFile = file(tree);
  if (asFile) return frame(asFile);
  if (isBit(tree)) return inline(tree.length ? 'true' : 'false');
  const number = nat(tree);
  if (number !== null) return inline(number.toLocaleString());
  const string = text(tree);
  if (string !== null)
    return inline(
      JSON.stringify(string.length > width ? `${string.slice(0, width)}…` : string),
    );
  return defaultPreview(tree);
}

/**
 * How big the value is, and how much of that is one node reached twice.
 *
 * Counted over the DAG, with an explicit stack: a value stands for a tree far
 * larger and far deeper than one that could be walked, and a hundred thousand
 * nodes is an ordinary answer here.
 */
export function size(tree: Tree): Preview {
  const counted = new Map<Tree, bigint>();
  const todo: Tree[] = [tree];
  while (todo.length) {
    const node = todo[todo.length - 1];
    if (counted.has(node)) {
      todo.pop();
      continue;
    }
    const children: readonly Tree[] = node;
    const missing = children.filter((child) => !counted.has(child));
    if (missing.length) {
      todo.push(...missing);
      continue;
    }
    counted.set(
      node,
      children.reduce((total, child) => total + counted.get(child)!, 1n),
    );
    todo.pop();
  }
  const nodes = counted.get(tree)!;
  const distinct = BigInt(counted.size);
  return inline(
    nodes === distinct
      ? `${nodes.toLocaleString()} nodes`
      : `${nodes.toLocaleString()} nodes, ${distinct.toLocaleString()} distinct`,
  );
}
