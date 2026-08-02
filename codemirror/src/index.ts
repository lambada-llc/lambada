import { LRLanguage, LanguageSupport } from '@codemirror/language';
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

export interface LambadaConfig {}

export function lambada(config: LambadaConfig = {}): LanguageSupport {
  return new LanguageSupport(lambadaLanguage);
}
