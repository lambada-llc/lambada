import type { Tree, Value } from '../tree';

/**
 * What `machine.js` offers, stated by hand.
 *
 * That file is vendored, so it stays plain JavaScript and close to what it was
 * copied from — annotating it would make every update from upstream a merge.
 * This is the seam instead: the worker is checked against what it says, and
 * this is the one place a change in the vendored file has to be noticed.
 */
export interface Machine {
  /** Reads a DAG. Throws on an unbound name or a document that never ends. */
  ofDag(text: string): Tree;
  /** Forces the tree and flattens it to indices. This is where the work is. */
  toNodes(tree: Tree): Pick<Value, 'nodes' | 'root'>;
  ofString(text: string): Tree;
  /** Throws unless every element of the list reads as a character. */
  toString(tree: Tree): string;
  /** Costs nothing: it conses, and nothing reduces until something forces it. */
  apply(f: Tree, x: Tree): Tree;
  /** Reduction steps, counted since it was last set to zero. */
  steps: { count: number };
}

export function makeMachine(): Machine;
