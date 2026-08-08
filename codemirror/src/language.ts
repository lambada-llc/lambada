import { LRLanguage } from '@codemirror/language';
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

/**
 * The characters `identifier` accepts in [syntax.grammar], as a pattern —
 * stated here rather than at each of the two places that need it, because both
 * are claims about what the grammar does and one copy cannot drift from the
 * other.
 */
export const identifier =
  /[@A-Z_`a-z\u{80}-\u{10ffff}][@A-Z_`a-z\u{80}-\u{10ffff}0-9.]*/u;

const whole = new RegExp(`^(?:${identifier.source})$`, 'u');

/** Whether a name is an identifier and nothing but. */
export const isIdentifier = (name: string): boolean => whole.test(name);
