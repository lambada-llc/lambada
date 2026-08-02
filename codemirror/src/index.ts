import { LRLanguage, LanguageSupport } from '@codemirror/language';
import { Prec, type Extension } from '@codemirror/state';
import { keymap, type Command } from '@codemirror/view';
import { styleTags, tags as t } from '@lezer/highlight';

import { parser } from './syntax.grammar';

export const lambadaLanguage = LRLanguage.define({
  parser: parser.configure({
    props: [
      styleTags({
        Natural: t.number,
        Char: t.string,
        String: t.string,
        LineComment: t.lineComment,
        '( ) [ ] { }': t.brace,
        // `\x` reads as one thing, so the backslash takes the binder's colour.
        // [Identifier] stays unpainted on purpose: in a language where nearly
        // every token is a name, marking names marks the whole document.
        'Backslash Binder': t.definition(t.variableName),
        Operator: t.operator,
      }),
    ],
  }),
  languageData: {
    commentTokens: { line: '#' },
  },
});

// The tree node operator. The language reads `t` as an alias for it, which is
// how the sample stays typeable without any of the below; these keys are for
// writing the character itself.
const node = '△';

// Four bindings for one insertion, because which of them reaches the page
// depends on the OS and the browser: `Alt-` is a dead-key prefix under some
// keyboard layouts, and `Ctrl-n` opens a window in some browsers. A host that
// knows what it is running on can name one key instead — `Mod-t`, say.
const defaultNodeKeys = ['Alt-t', 'Alt-n', 'Ctrl-t', 'Ctrl-n'];

const insertNode: Command = ({ state, dispatch }) => {
  if (state.readOnly) return false;
  dispatch(
    state.update(state.replaceSelection(node), {
      scrollIntoView: true,
      userEvent: 'input.type',
    }),
  );
  return true;
};

// Highest precedence: `Ctrl-t` is `transposeChars` in CodeMirror's standard
// keymap on mac, and a binding that loses to it is worse than no binding.
const nodeKeymap = (keys: readonly string[]): Extension =>
  keys.length
    ? Prec.highest(keymap.of(keys.map((key) => ({ key, run: insertNode }))))
    : [];

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
