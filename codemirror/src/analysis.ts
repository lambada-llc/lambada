import type { EditorState } from '@codemirror/state';

import { lambadaCompilations } from './compilation';
import { lambadaStatements, type Statement } from './statements';

export interface Problem {
  /** The name that is not in scope. */
  symbol: string;
  message: string;
}

export type StatementState =
  /** Not compiled yet. */
  | 'pending'
  /** Compiled, and everything it names is in scope. */
  | 'ok'
  /** Would not compile, or names something that is not in scope. */
  | 'error'
  /** Nothing can be said until an earlier statement settles. */
  | 'blocked';

export interface Analysis {
  statement: Statement;
  state: StatementState;
  problems: readonly Problem[];
}

// The DAG format binds `△` to the leaf, and the compiler calls that same leaf
// `__ENV△` in what it emits. Both are in scope before any environment is read.
const builtIn = ['△', '__ENV△'];

/**
 * The names a DAG module defines, which for an environment is what it brings
 * into scope. See https://github.com/lambada-llc/tree-calculus/blob/main/conventions/README.md#dag-modules
 */
export function definedBy(environment: string): string[] {
  const names: string[] = [];
  for (const line of environment.split(/\r?\n/)) {
    const [name, value] = line.split(' ');
    if (name && value) names.push(name);
  }
  return names;
}

/**
 * Walks the statements in order, carrying the names in scope forward.
 *
 * A statement that has not compiled stops the walk — it may define anything,
 * and guessing would turn one unfinished line into a page of errors. That is
 * what `blocked` means.
 *
 * One that compiled but names something unknown does not stop it. Its
 * definitions are all there in what the compiler produced, so they carry
 * forward and the statements below it are judged on their own.
 */
export function analyze(
  state: EditorState,
  environment: string,
): readonly Analysis[] {
  const compilations = state.field(lambadaCompilations);
  const scope = new Set([...builtIn, ...definedBy(environment)]);
  const analyses: Analysis[] = [];
  let stopped = false;

  for (const statement of state.field(lambadaStatements)) {
    if (stopped) {
      analyses.push({ statement, state: 'blocked', problems: [] });
      continue;
    }

    const known = compilations.get(statement.text);
    if (!known || known.status === 'pending') {
      stopped = true;
      analyses.push({ statement, state: 'pending', problems: [] });
      continue;
    }
    if (known.status === 'error') {
      stopped = true;
      analyses.push({
        statement,
        state: 'error',
        problems: [{ symbol: '', message: known.message }],
      });
      continue;
    }

    // Each line defines its first name in terms of the ones after it, so a
    // name is in scope from the line below the one that introduced it.
    const problems: Problem[] = [];
    const missing = (name: string) => {
      if (scope.has(name) || problems.some((p) => p.symbol === name)) return;
      problems.push({ symbol: name, message: `${name} is not defined` });
    };
    for (const line of known.dagLines) {
      const [name, first, second] = line.split(' ');
      if (first) {
        missing(first);
        if (second) missing(second);
        scope.add(name);
      } else if (name) {
        missing(name);
      }
    }

    analyses.push({
      statement,
      state: problems.length ? 'error' : 'ok',
      problems,
    });
  }

  return analyses;
}
