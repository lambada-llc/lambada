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
  name: string;
  /** The one or two names it is built from; neither, for a bare name. */
  from: readonly string[];
}

export function dagLine(line: string): DagLine {
  const [name, first, second] = line.split(' ');
  return { name, from: second ? [first, second] : first ? [first] : [] };
}
