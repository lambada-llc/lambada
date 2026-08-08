import type { EditorState, Extension, StateField } from '@codemirror/state';

import { results, type Outcome } from './compile';
import type { Resolved } from './config';
import { lambadaStatements } from './statements';

/** The DAG the compiler emitted for one statement, and what it cost. */
interface Compiled {
  dagLines: readonly string[];
  steps: number;
}

/** What the compiler produced for one statement. */
export type Compilation = Outcome<Compiled>;

const compiled = results<Compiled>('compile');

/**
 * What is known about each statement, keyed by its text rather than its
 * position — so an edit above a statement does not throw away its result, and
 * two statements that read the same are compiled once.
 */
export const lambadaCompilations: StateField<ReadonlyMap<string, Compilation>> =
  compiled.field;

const statementTexts = (state: EditorState): Iterable<string> =>
  state.field(lambadaStatements).map((statement) => statement.text);

export const compilation = (config: Resolved): Extension => [
  lambadaCompilations,
  compiled.keep(config, statementTexts),
];
