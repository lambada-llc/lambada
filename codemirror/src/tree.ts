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
