import { LanguageSupport } from '@codemirror/language';

import { lambadaLanguage } from './language';
import { defaultNodeKeys, nodeKeymap } from './node-keys';

export { lambadaLanguage };

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
  return new LanguageSupport(lambadaLanguage, nodeKeymap(keys));
}
