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
