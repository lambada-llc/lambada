import { LanguageSupport } from '@codemirror/language';

import { initialScope } from './analysis';
import { compilation, lambadaCompilations } from './compilation';
import { completions } from './completions';
import { resolve, type CompileConfig } from './config';
import { gotoDefinition, resolveGoto, type GotoDefinitionConfig } from './definitions';
import { diagnostics } from './diagnostics';
import { defaultPreview, previews } from './previews';
import { lambadaLanguage } from './language';
import { defaultNodeKeys, insertNode, nodeKeymap } from './node-keys';
import { lambadaStatements } from './statements';
import { statementStatus } from './status';
import { symbolHighlights, symbolRanges } from './symbols';
import { dagOf } from './dag';

export {
  lambadaLanguage,
  lambadaStatements,
  lambadaCompilations,
  insertNode,
  dagOf,
  defaultPreview,
  symbolRanges,
};
export type { Statement } from './statements';
export type { Compilation } from './compilation';
export type { Preview } from './previews';
export type { Tree } from './tree';
export type { GotoDefinitionConfig } from './definitions';

export interface LambadaConfig {
  /**
   * Keys that insert `△`. `true`, the default, binds `Alt-t`, `Alt-n`,
   * `Ctrl-t` and `Ctrl-n`; an array replaces those with keys of your own, in
   * CodeMirror's notation — `Mod-` included. `false` binds nothing.
   */
  nodeKeys?: boolean | readonly string[];
  /**
   * Highlight the occurrences of the name at the cursor, scope-aware.
   * Default: true.
   */
  highlightSymbols?: boolean;
  /**
   * Jump to a name's definition, on modifier-click and on a key. Default:
   * true — a bound use jumps to its binder, a use of a definition to the
   * statement that defines it. Where a name the *environment* defines should
   * go is the host's to say; see [GotoDefinitionConfig]. `false` offers no
   * jumps at all.
   */
  gotoDefinition?: boolean | GotoDefinitionConfig;
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
  highlightSymbols = true,
  gotoDefinition: gotoConfig = true,
  compile = true,
}: LambadaConfig = {}): LanguageSupport {
  const keys = nodeKeys === true ? defaultNodeKeys : nodeKeys || [];
  const config = resolve(compile);
  const goto = resolveGoto(gotoConfig);
  // Statements are not optional: read-only they cost a pass over a document
  // that never changes, and editable there is little to be done without them.
  return new LanguageSupport(lambadaLanguage, [
    nodeKeymap(keys),
    lambadaStatements,
    highlightSymbols ? symbolHighlights() : [],
    // The environment's names decide which jumps the host is asked about;
    // with compiling off nothing is in scope but the leaf, and the jumps
    // within the document need no scope at all.
    goto ? gotoDefinition(goto, config ? config.initialScope : initialScope([])) : [],
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
