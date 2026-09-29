import { StateField, type Text } from '@codemirror/state';

export interface Statement {
  /** Offset of the first character of the statement's first line. */
  from: number;
  /** Offset of the end of its last line of code. */
  to: number;
  /**
   * Its lines of code, joined with newlines. The first is trimmed and the rest
   * keep their indentation, which is what tells a continuation apart from the
   * line it continues.
   */
  text: string;
}

/**
 * Splits a document into statements by the compiler's own layout rule (its
 * `statements`), so what is marked as one statement is what the build compiles
 * as one. A line starting at column 0 starts one, and the indented lines below
 * it — by a space or a tab — continue it. Blank lines and comment lines are not code: they neither start a
 * statement nor end one, and a statement of nothing but a comment is never
 * sent to the compiler, which would answer it with nothing.
 */
function splitStatements(doc: Text): readonly Statement[] {
  const isCode = (text: string) => text.trim() !== '' && !text.startsWith('#');
  const isIndented = (text: string) => text.startsWith(' ') || text.startsWith('\t');
  const result: Statement[] = [];

  for (let n = 1; n <= doc.lines; ) {
    while (n <= doc.lines && !isCode(doc.line(n).text)) n++;
    if (n > doc.lines) break;

    const first = doc.line(n++);
    const lines = [first.text.trim()];
    let last = first;
    for (; n <= doc.lines; n++) {
      const line = doc.line(n);
      if (!isCode(line.text)) continue;
      if (!isIndented(line.text)) break;
      lines.push(line.text.trimEnd());
      last = line;
    }

    result.push({ from: first.from, to: last.to, text: lines.join('\n') });
  }

  return result;
}

export const lambadaStatements = StateField.define<readonly Statement[]>({
  create: (state) => splitStatements(state.doc),
  update: (statements, tr) =>
    tr.docChanged ? splitStatements(tr.newDoc) : statements,
});
