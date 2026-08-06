/**
 * A value: the leaf, a stem or a fork, as an array of that node's children.
 * A shared subtree is one array, so a value stands for far more nodes than it
 * holds — walking one without remembering what it has seen does not come back.
 */
export type Tree = readonly [] | readonly [Tree] | readonly [Tree, Tree];

/**
 * What an expression evaluated to, as it crosses back from the worker: two
 * slots per node holding the indices of its children, -1 where it has none,
 * and children before parents.
 */
export interface Value {
  nodes: readonly number[];
  root: number;
  steps: number;
}

/**
 * The tree a value stands for.
 *
 * Put together here rather than sent as one, because the structured clone that
 * carries a message out of a worker recurses over what it copies: a value
 * nests as deep as a string is long, and past a couple of thousand characters
 * the copy overflows the worker's stack and the evaluation is lost with it.
 * Indices cross at any depth, and this loop does not recurse either.
 */
export function treeOf({ nodes, root }: Value): Tree {
  const built: Tree[] = [];
  for (let i = 0; i < nodes.length; i += 2) {
    const left = nodes[i],
      right = nodes[i + 1];
    built.push(left < 0 ? [] : right < 0 ? [built[left]] : [built[left], built[right]]);
  }
  return built[root];
}

/**
 * A tree written as a
 * [DAG](https://github.com/lambada-llc/tree-calculus/blob/main/conventions/README.md#dag-directed-acyclic-graph):
 * a line per application, then a bare name for the whole.
 *
 * This is how a value leaves the editor for anywhere else — a program that
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
