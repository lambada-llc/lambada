import { Facet, type EditorState, type StateField } from '@codemirror/state';

import { lambadaCompilations } from './compilation';
import { dagLine, needed, type DagLine } from './dag';
import { treeOf, type Tree, type Value } from './tree';
import { results, type Outcome } from './worker';

// Evaluating what the host asks: any expression, in the scope of any place in
// the document — the same compiler, the same programs and the same worker that
// evaluate the document's own expressions.

/** An expression to evaluate, and where: with every definition the document
 * makes above `at` in scope, and the environment's. */
export interface Evaluation {
  at: number;
  source: string;
}

/**
 * What a host wants evaluated. Each function is asked of every state, and
 * what it names is compiled and evaluated and kept for as long as it is still
 * named; `evaluation` reads the answer. Asked outside any state update, so it
 * may read any field — the document's tests, the answers so far.
 */
export const lambadaEvaluations = Facet.define<(state: EditorState) => readonly Evaluation[]>();

export const requested = (state: EditorState): readonly Evaluation[] =>
  state.facet(lambadaEvaluations).flatMap((wanted) => wanted(state));

/** The definitions in scope down the document. */
export interface Scope {
  /** The prelude, the environment, then every definition the document makes,
   * in order. A program is a prefix of these and what it evaluates. */
  lines: readonly DagLine[];
  /** How many of `lines` are the prelude's and the environment's. */
  base: number;
  /** After each statement whose definitions are in `lines`: where it ends,
   * and how many of `lines` were in scope then. */
  marks: readonly { to: number; length: number }[];
  /** How far down the document the definitions are known: past a statement
   * that did not compile, what is in scope is not. */
  known: number;
}

/** Which field holds the scope, in an editor that compiles. */
export const scopeHolder = Facet.define<StateField<{ scope: Scope }>, StateField<{ scope: Scope }> | null>({
  combine: (fields) => fields[0] ?? null,
});

/** A program's evaluation, keyed by the program's text. */
export const evaluated = results<Value>('run');

/** The program that evaluates `request`, or why there is none (yet). */
export function programOf(state: EditorState, { at, source }: Evaluation): Outcome<{ program: string }> {
  const field = state.facet(scopeHolder);
  const compiled = state.field(lambadaCompilations).get(source);
  if (!field || !compiled || compiled.status === 'pending') return { status: 'pending' };
  if (compiled.status === 'error') return compiled;
  const { scope } = state.field(field);
  if (at > scope.known) return { status: 'pending' };
  const lines = compiled.dagLines.filter((line) => line.trim()).map(dagLine);
  const bare = lines.find((line) => line.from.length === 0);
  if (!bare) return { status: 'error', message: 'not an expression' };
  let length = scope.base;
  for (const mark of scope.marks) if (mark.to <= at) length = mark.length;
  const program = needed([
    ...scope.lines.slice(0, length),
    ...lines.filter((line) => line !== bare),
    bare,
  ]);
  return { status: 'ok', program: program.map((line) => line.text).join('\n') };
}

/** What `request` evaluated to: pending until it is known, and an error where
 * it does not compile, or did not finish in time. */
export function evaluation(state: EditorState, request: Evaluation): Outcome<{ tree: Tree }> {
  const program = programOf(state, request);
  if (program.status !== 'ok') return program;
  const answer = state.field(evaluated.field).get(program.program);
  if (!answer || answer.status !== 'ok') return answer ?? { status: 'pending' };
  return { status: 'ok', tree: treeOf(answer) };
}
