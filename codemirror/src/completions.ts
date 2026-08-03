import type {
  CompletionContext,
  CompletionResult,
} from '@codemirror/autocomplete';
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

import { isOfferable, scopeAt } from './analysis';
import { lambadaLanguage } from './language';

// The same fix the diagnostics needed, for the same reason: a theme that picks
// the completion list's background from the wrong end of its palette leaves
// every row but the selected one unreadable. A base theme, so a theme that
// does style the list still wins — this only shows through where nothing else
// has an opinion.
// On the list inside the tooltip rather than the tooltip: a theme's rule for
// `.cm-tooltip` outranks a base theme's for the same element, so a background
// stated there would never show. The list is a child, and painting a child
// covers what is behind it.
const theme = EditorView.baseTheme({
  '&light .cm-tooltip-autocomplete > ul': {
    backgroundColor: '#f5f5f5',
    color: '#1c1c1c',
  },
  '&dark .cm-tooltip-autocomplete > ul': {
    backgroundColor: '#2b2b2b',
    color: '#eeeeee',
  },
});

// The same characters the grammar's `identifier` accepts, so that what is
// matched before the cursor is what would be replaced.
const identifier =
  /[@A-Z_`a-z\u{80}-\u{10ffff}][@A-Z_`a-z\u{80}-\u{10ffff}0-9.]*/u;

/**
 * The names in scope where the cursor is.
 *
 * Added as language data rather than as a completion source of its own, so a
 * host with more to offer — a standard library, snippets — adds theirs beside
 * it and both appear.
 */
export function completions(environment: string): Extension {
  return [
    theme,
    lambadaLanguage.data.of({
      autocomplete(context: CompletionContext): CompletionResult | null {
        const word = context.matchBefore(identifier);
        if (!word && !context.explicit) return null;
        const from = word ? word.from : context.pos;

        const options = [];
        for (const [name, definedIn] of scopeAt(
          context.state,
          environment,
          context.pos,
        )) {
          if (!isOfferable(name)) continue;
          options.push({
            label: name,
            type: 'variable',
            // What the name was defined by, which is more use than a type would
            // be in a language where every name is a tree.
            info: definedIn ?? undefined,
          });
        }
        return options.length ? { from, options } : null;
      },
    }),
  ];
}
