import type { Tree } from './tree';

/**
 * The DAG the compiler emitted for one statement, and what it cost.
 *
 * The worker builds this and the editor reads it, so it lives where neither
 * has to reach the other: this file reaches only [Tree], which reaches nothing,
 * and a thread with no DOM can read the same declaration the editor does.
 */
export interface Compiled {
  dagLines: readonly string[];
  steps: number;
}

/**
 * A line of the DAG text format, split into what it names and what it is made
 * of: `a b c` names the application of `b` to `c`, `a b` names `b` again, and a
 * bare `a` ends a document, naming its value. See
 * https://github.com/lambada-llc/tree-calculus/blob/main/conventions/README.md#dag-modules
 *
 * A module is all definitions and no terminator. What the compiler emits for
 * one statement ends in a bare name when that statement was an expression, and
 * in nothing when it was a definition.
 */
export interface DagLine {
  /** As written, so that lines kept can be written back out unchanged. */
  text: string;
  name: string;
  /** The one or two names it is built from; neither, for a bare name. */
  from: readonly string[];
}

export function dagLine(text: string): DagLine {
  const [name, first, second] = text.split(' ');
  return { text, name, from: second ? [first, second] : first ? [first] : [] };
}

/** A name's span suffix, decoded. */
export interface Span {
  base: string;
  /** Character range into the compiled statement's text, end-exclusive, in code points. */
  from: number;
  to: number;
}

const SPAN = /^(.*)::(\d+),(\d+)$/;

/**
 * The compiler's span-aware variant annotates what it emits with source
 * ranges, as one uniform rule: an alias line `B::s,e B` says `B` was written
 * at [s, e) of the statement it compiled, and references go through the
 * alias. This decodes such a name; an ordinary name is null. `::` cannot
 * occur in an identifier, so a spanned name never collides with one a
 * program writes — which is also what tells these alias lines apart from the
 * definitions a statement exports: a span *annotates* a name, it defines
 * nothing, and everything that reads compiled lines reads them through this.
 */
export function spanned(name: string): Span | null {
  const m = SPAN.exec(name);
  return m && { base: m[1], from: Number(m[2]), to: Number(m[3]) };
}

export const dagLines = (document: string): readonly DagLine[] =>
  document.split(/\r?\n/).map(dagLine);

/**
 * Lines in scope, in order — a base shared by every document, then whatever a
 * document adds as it is walked — with where each name is bound. `needed` can
 * then be asked of any prefix of them, as often as there are expressions, at
 * the cost of what it keeps rather than of everything in scope: an environment
 * runs to a hundred thousand lines, and an expression reaches a fraction.
 *
 * A base is not added to once something is built on it.
 */
export class Bindings {
  readonly #lines: DagLine[] = [];
  /** Where each name is bound, in increasing order: indices into the whole. */
  readonly #at = new Map<string, number[]>();
  readonly #offset: number;

  constructor(
    readonly base: Bindings | null = null,
    lines: Iterable<DagLine> = [],
  ) {
    this.#offset = base?.length ?? 0;
    for (const line of lines) this.push(line);
  }

  get length(): number {
    return this.#offset + this.#lines.length;
  }

  push(line: DagLine): void {
    if (line.from.length) {
      const at = this.#at.get(line.name);
      if (at) at.push(this.length);
      else this.#at.set(line.name, [this.length]);
    }
    this.#lines.push(line);
  }

  line(index: number): DagLine {
    return index < this.#offset ? this.base!.line(index) : this.#lines[index - this.#offset];
  }

  /** The nearest line above `limit` that binds `name`, or -1. */
  #bound(name: string, limit: number): number {
    const at = this.#at.get(name);
    // Most names are bound once, and asked about from below that.
    if (at && at[at.length - 1] < limit) return at[at.length - 1];
    if (at && at[0] < limit) {
      let low = 0;
      let high = at.length - 1;
      while (low < high) {
        const middle = (low + high + 1) >> 1;
        if (at[middle] < limit) low = middle;
        else high = middle - 1;
      }
      return at[low];
    }
    return this.base ? this.base.#bound(name, Math.min(limit, this.#offset)) : -1;
  }

  /**
   * Just the lines that decide the value `tail` ends with, reading the first
   * `length` lines in scope and then `tail`, in the order they were written.
   *
   * A DAG is a chain of `let`s: the binding that answers a use is the nearest
   * one above it, and a binding some later one shadowed is left behind along
   * with everything only it needed. The compiler reuses its names — `:t`, `0`
   * — across statements, so which binding a name means is a question about
   * where it stands, not about the name. Each use is followed to that binding
   * here, rather than walking every line upward: a program reaches a fraction
   * of what is in scope.
   *
   * A name no line binds is simply not mentioned again, which is how a
   * reference reaches whatever the reader has in scope to begin with.
   */
  needed(length: number, tail: readonly DagLine[]): readonly DagLine[] {
    const end = tail.findIndex((line) => line.name && !line.from.length);
    if (end < 0) return [...Array.from({ length }, (_, i) => this.line(i)), ...tail];
    // Which of the lines in scope are kept, one byte each: a program reaches
    // tens of thousands of them, and reading them back in order is a scan.
    const here = new Uint8Array(length);
    const there = new Set<number>([end]);
    const uses: [string, number][] = [[tail[end].name, length + end]];
    while (uses.length) {
      const [name, at] = uses.pop()!;
      let found = -1;
      for (let i = at - length - 1; i >= 0; i--)
        if (tail[i].from.length && tail[i].name === name) {
          found = length + i;
          break;
        }
      if (found < 0) found = this.#bound(name, Math.min(at, length));
      if (found < 0) continue;
      if (found < length) {
        if (here[found]) continue;
        here[found] = 1;
      } else {
        if (there.has(found - length)) continue;
        there.add(found - length);
      }
      for (const used of (found < length ? this.line(found) : tail[found - length]).from) uses.push([used, found]);
    }
    const kept: DagLine[] = [];
    for (let index = 0; index < length; index++) if (here[index]) kept.push(this.line(index));
    for (let index = 0; index < tail.length; index++) if (there.has(index)) kept.push(tail[index]);
    return kept;
  }
}

/**
 * A tree written as a
 * [DAG](https://github.com/lambada-llc/tree-calculus/blob/main/conventions/README.md#dag-directed-acyclic-graph):
 * a line per application, then a bare name for the whole.
 *
 * This is how a value leaves the page for anywhere else — a program that
 * renders it, a file, a link — since a `Tree` is only reachable from the page
 * that evaluated it.
 */
export function dagOf(tree: Tree): string {
  const lines: string[] = [];
  const named = new Map<Tree, string>();
  // Names for applications, not just for nodes. This is what keeps the output
  // a DAG rather than a tree: two subtrees that were never shared in memory
  // still end up as one name, because they are built of the same applications.
  const applied = new Map<string, string>();
  let next = 0;

  const apply = (left: string, right: string): string => {
    const key = `${left} ${right}`;
    let name = applied.get(key);
    if (name === undefined) {
      applied.set(key, (name = `${next++}`));
      lines.push(`${name} ${key}`);
    }
    return name;
  };

  // An explicit stack, for the reason `treeOf` builds one: a value nests as
  // deep as the data it holds is long, and the call stack does not go that far.
  const todo: Tree[] = [tree];
  while (todo.length) {
    const node = todo[todo.length - 1];
    if (named.has(node)) {
      todo.pop();
      continue;
    }
    let waiting = false;
    for (const child of node)
      if (!named.has(child)) {
        todo.push(child);
        waiting = true;
      }
    if (waiting) continue;
    // Every node is the leaf with its children applied to it in turn.
    let name = '△';
    for (const child of node) name = apply(name, named.get(child)!);
    named.set(node, name);
    todo.pop();
  }

  lines.push(named.get(tree)!);
  return lines.join('\n');
}
