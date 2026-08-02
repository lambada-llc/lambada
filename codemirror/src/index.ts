import { LanguageSupport } from '@codemirror/language';

import { compilation, lambadaCompilations, type CompileConfig } from './compilation';
import { lambadaLanguage } from './language';
import { defaultNodeKeys, nodeKeymap } from './node-keys';
import { lambadaStatements } from './statements';
import { statementStatus } from './status';

export { lambadaLanguage, lambadaStatements, lambadaCompilations };
export type { Statement } from './statements';
export type { Compilation } from './compilation';

export interface LambadaConfig {
  /**
   * Keys that insert `△`. `true`, the default, binds `Alt-t`, `Alt-n`,
   * `Ctrl-t` and `Ctrl-n`; an array replaces those with keys of your own, in
   * CodeMirror's notation — `Mod-` included. `false` binds nothing.
   */
  nodeKeys?: boolean | readonly string[];
  /**
   * Compile each statement, on a worker, and mark it with how that went.
   * `true`, the default, uses the compiler this package ships; an object
   * supplies your own or changes how long a statement may take. `false`
   * compiles nothing, leaving the editing support on its own.
   */
  compile?: boolean | CompileConfig;
}

export function lambada({
  nodeKeys = true,
  compile = true,
}: LambadaConfig = {}): LanguageSupport {
  const keys = nodeKeys === true ? defaultNodeKeys : nodeKeys || [];
  // Statements are not optional: read-only they cost a pass over a document
  // that never changes, and editable there is little to be done without them.
  return new LanguageSupport(lambadaLanguage, [
    nodeKeymap(keys),
    lambadaStatements,
    compile ? [compilation(compile === true ? {} : compile), statementStatus()] : [],
  ]);
}
