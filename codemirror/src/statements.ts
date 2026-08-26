import { StateField, type Text } from '@codemirror/state';

/** One kept line: `length` characters at `chunk` in the text, `doc` in the document. */
export interface Piece {
  chunk: number;
  doc: number;
  length: number;
}

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
  /**
   * Where each piece of `text` sits in the document, one entry per kept line,
   * in order. `text` is not a slice of the document — lines were trimmed and
   * blank ones dropped — so a position in one reaches the other through these;
   * see [chunkPos] and [docPos]. Built in the same pass that builds `text`,
   * which is what keeps the two from ever disagreeing.
   */
  pieces: readonly Piece[];
}

/**
 * The position in `statement.text` for a document position, or null where the
 * document kept nothing — trimmed whitespace, a blank line. Both ends of a
 * piece are its: a cursor sits between characters, so a boundary belongs to
 * the text on either side of it.
 */
export function chunkPos(statement: Statement, pos: number): number | null {
  for (const piece of statement.pieces)
    if (piece.doc <= pos && pos <= piece.doc + piece.length)
      return piece.chunk + (pos - piece.doc);
  return null;
}

/**
 * The document position for a position in `statement.text`, or null on a
 * joining newline, which stands for whatever the document dropped between two
 * kept lines and has no one position there.
 */
export function docPos(statement: Statement, pos: number): number | null {
  for (const piece of statement.pieces)
    if (piece.chunk <= pos && pos <= piece.chunk + piece.length)
      return piece.doc + (pos - piece.chunk);
  return null;
}

/**
 * Splits a document into statements. One runs from a line that is not blank up
 * to the last line indented under it.
 *
 * Indented means starting with a space — a tab does not continue a statement,
 * and neither does a blank line, though a line of only spaces does without
 * contributing anything.
 */
function splitStatements(doc: Text): readonly Statement[] {
  const blank = (text: string) => text.trim() === '';
  const result: Statement[] = [];

  for (let n = 1; n <= doc.lines; ) {
    while (n <= doc.lines && blank(doc.line(n).text)) n++;
    if (n > doc.lines) break;

    const lines: string[] = [];
    const pieces: Piece[] = [];
    let length = 0;
    const keep = (kept: string, doc: number) => {
      if (lines.length) length++; // the newline the join writes
      pieces.push({ chunk: length, doc, length: kept.length });
      lines.push(kept);
      length += kept.length;
    };

    const first = doc.line(n++);
    keep(first.text.trim(), first.from + (first.text.length - first.text.trimStart().length));
    let last = first;
    while (n <= doc.lines && doc.line(n).text.startsWith(' ')) {
      const line = doc.line(n++);
      if (blank(line.text)) continue;
      keep(line.text.trimEnd(), line.from);
      last = line;
    }

    result.push({ from: first.from, to: last.to, text: lines.join('\n'), pieces });
  }

  return result;
}

export const lambadaStatements = StateField.define<readonly Statement[]>({
  create: (state) => splitStatements(state.doc),
  update: (statements, tr) =>
    tr.docChanged ? splitStatements(tr.newDoc) : statements,
});
