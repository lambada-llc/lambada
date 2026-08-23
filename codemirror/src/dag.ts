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

export const dagLines = (document: string): readonly DagLine[] =>
  document.split(/\r?\n/).map(dagLine);

/**
 * Just the lines that decide the value the document ends with, in the order
 * they were written.
 *
 * A DAG is a chain of `let`s, so this walks upwards from the end: the binding
 * that answers a use is the nearest one above it, and a binding some later one
 * shadowed is left behind along with everything only it needed. The compiler
 * reuses its names — `:t`, `0` — across statements, so which binding a name
 * means is a question about where it stands, not about the name.
 *
 * A name no line binds stays wanted and is simply not mentioned again, which is
 * how a reference reaches whatever the reader has in scope to begin with.
 */
export function needed(lines: readonly DagLine[]): readonly DagLine[] {
  const end = lines.findIndex((line) => line.name && !line.from.length);
  // Nothing names a value, so nothing can be dropped on that basis.
  if (end < 0) return lines;

  const wanted = new Set([lines[end].name]);
  const keep: DagLine[] = [lines[end]];
  for (let i = end - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.from.length || !wanted.has(line.name)) continue;
    keep.push(line);
    // Satisfied here, so a binding further up is one this line shadowed —
    // unless what it is built from names it again, which the adding restores.
    wanted.delete(line.name);
    for (const name of line.from) wanted.add(name);
  }
  return keep.reverse();
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
