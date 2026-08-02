import { StateField, type Text } from '@codemirror/state';

export interface Statement {
  /** Offset of the first character of the statement's first line. */
  from: number;
  /** Offset of the end of its last line that is not blank. */
  to: number;
  /**
   * The lines, blank ones dropped, joined with newlines. The first is trimmed
   * and the rest keep their indentation, which is what tells a continuation
   * apart from the line it continues.
   */
  text: string;
}

/**
 * Splits a document into statements. One runs from a line that is not blank up
 * to the last line indented under it.
 *
 * Indented means starting with a space — a tab does not continue a statement,
 * and neither does a blank line, though a line of only spaces does without
 * contributing anything.
 */
export function splitStatements(doc: Text): readonly Statement[] {
  const blank = (text: string) => text.trim() === '';
  const result: Statement[] = [];

  for (let n = 1; n <= doc.lines; ) {
    while (n <= doc.lines && blank(doc.line(n).text)) n++;
    if (n > doc.lines) break;

    const first = doc.line(n++);
    const lines = [first.text.trim()];
    let last = first;
    while (n <= doc.lines && doc.line(n).text.startsWith(' ')) {
      const line = doc.line(n++);
      if (blank(line.text)) continue;
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
