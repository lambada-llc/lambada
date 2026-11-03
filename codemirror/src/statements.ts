import { StateField, type Text } from '@codemirror/state';

import { split } from './split';

export interface Statement {
  /** Offset of the first character of the statement's first line. */
  from: number;
  /** Offset of the end of its last line of code. */
  to: number;
  /** Its lines of code, as [split] has them. */
  text: string;
}

/** A document's statements, by [split], placed back into it as offsets. */
function splitStatements(doc: Text): readonly Statement[] {
  return split(doc.lines, (n) => doc.line(n).text).map(({ first, last, text }) => ({
    from: doc.line(first).from,
    to: doc.line(last).to,
    text,
  }));
}

export const lambadaStatements = StateField.define<readonly Statement[]>({
  create: (state) => splitStatements(state.doc),
  update: (statements, tr) =>
    tr.docChanged ? splitStatements(tr.newDoc) : statements,
});
