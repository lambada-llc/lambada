// The layout rule a source is split into statements by, with nothing of the
// editor in it, so it can be held against the compiler's own: lambada's
// `codemirror/scripts/statements-agree.mjs` runs both over the same sources and
// fails on any difference.

/** One statement, by the 1-based numbers of its first and last code line. */
export interface Split {
  first: number;
  last: number;
  /**
   * Its lines of code, joined with newlines, exactly as written: whitespace
   * can be inside a string literal that spans lines, so none of it is the
   * editor's to drop.
   */
  text: string;
}

/**
 * The statements of a source of `count` lines, line `n` of which is
 * `line(n)` — asked for rather than handed over as an array, so an editor's
 * document is not copied out line by line on every keystroke.
 *
 * The compiler's rule (its `statements`): a line starting at column 0 starts a
 * statement, and the indented lines below it — by a space or a tab — continue
 * it. Empty lines and comment lines are not code: they neither start a
 * statement nor end one. A line of nothing but spaces *is* code, as it is to
 * the build (`is_source_line`): indented, it continues a statement — and inside
 * a string that spans lines, it is part of the string.
 */
export function split(count: number, line: (n: number) => string): Split[] {
  const isCode = (text: string) => text !== '' && !text.startsWith('#');
  const isIndented = (text: string) => text.startsWith(' ') || text.startsWith('\t');
  const result: Split[] = [];

  for (let n = 1; n <= count; ) {
    while (n <= count && !isCode(line(n))) n++;
    if (n > count) break;

    const first = n++;
    const lines = [line(first)];
    let last = first;
    for (; n <= count; n++) {
      const text = line(n);
      if (!isCode(text)) continue;
      if (!isIndented(text)) break;
      lines.push(text);
      last = n;
    }

    result.push({ first, last, text: lines.join('\n') });
  }

  return result;
}
