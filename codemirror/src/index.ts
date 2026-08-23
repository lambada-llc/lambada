import { LanguageSupport } from '@codemirror/language';

import { compilation, lambadaCompilations } from './compilation';
import { completions } from './completions';
import { resolve, type CompileConfig } from './config';
import { diagnostics } from './diagnostics';
import { defaultPreview, previews } from './previews';
import { lambadaLanguage } from './language';
import { defaultNodeKeys, insertNode, nodeKeymap } from './node-keys';
import { lambadaStatements } from './statements';
import { statementStatus } from './status';
import { dagOf } from './dag';

export {
  lambadaLanguage,
  lambadaStatements,
  lambadaCompilations,
  insertNode,
  dagOf,
  defaultPreview,
};
export type { Statement } from './statements';
export type { Compilation } from './compilation';
export type { Preview } from './previews';
export type { Tree } from './tree';

export interface LambadaConfig {
  /**
   * Keys that insert `△`. `true`, the default, binds `Alt-t`, `Alt-n`,
   * `Ctrl-t` and `Ctrl-n`; an array replaces those with keys of your own, in
   * CodeMirror's notation — `Mod-` included. `false` binds nothing.
   */
  nodeKeys?: boolean | readonly string[];
  /**
   * Compile each statement, on a worker. `true`, the default, uses the
   * compiler this package ships; `false` compiles nothing, leaving the editing
   * support on its own.
   *
   * Everything that reads a compilation is configured in here rather than
   * beside it, because none of it means anything without one: the marks, the
   * names reported and offered, and the values written at the end of a line.
   */
  compile?: boolean | CompileConfig;
}

export function lambada({
  nodeKeys = true,
  compile = true,
}: LambadaConfig = {}): LanguageSupport {
  const keys = nodeKeys === true ? defaultNodeKeys : nodeKeys || [];
  const config = resolve(compile);
  // Statements are not optional: read-only they cost a pass over a document
  // that never changes, and editable there is little to be done without them.
  return new LanguageSupport(lambadaLanguage, [
    nodeKeymap(keys),
    lambadaStatements,
    config
      ? [
          compilation(config),
          config.showStatus ? statementStatus(config) : [],
          config.showDiagnostics ? diagnostics(config) : [],
          config.showPreviews ? previews(config) : [],
          config.showCompletions ? completions(config) : [],
        ]
      : [],
  ]);
}
