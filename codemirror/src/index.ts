import { LanguageSupport } from '@codemirror/language';

import { lambadaLanguage } from './language';
import { defaultNodeKeys, nodeKeymap } from './node-keys';
import { lambadaStatements } from './statements';

export { lambadaLanguage, lambadaStatements };
export type { Statement } from './statements';

export interface LambadaConfig {
  /**
   * Keys that insert `△`. `true`, the default, binds `Alt-t`, `Alt-n`,
   * `Ctrl-t` and `Ctrl-n`; an array replaces those with keys of your own, in
   * CodeMirror's notation — `Mod-` included. `false` binds nothing.
   */
  nodeKeys?: boolean | readonly string[];
}

export function lambada({
  nodeKeys = true,
}: LambadaConfig = {}): LanguageSupport {
  const keys = nodeKeys === true ? defaultNodeKeys : nodeKeys || [];
  // Statements are not optional: read-only they cost a pass over a document
  // that never changes, and editable there is little to be done without them.
  return new LanguageSupport(lambadaLanguage, [
    nodeKeymap(keys),
    lambadaStatements,
  ]);
}
