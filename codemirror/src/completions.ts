import type {
  CompletionContext,
  CompletionResult,
} from '@codemirror/autocomplete';
import type { Extension } from '@codemirror/state';

import { isOfferable, scopeAt } from './analysis';
import type { Resolved } from './config';
import { identifier, lambadaLanguage } from './language';
import { legible } from './tooltips';

// The list inside the tooltip rather than the tooltip: a theme's rule for
// `.cm-tooltip` outranks a base theme's for the same element, so a background
// stated there would never show. The list is a child, and painting a child
// covers what is behind it.
// The panel beside the list, saying what defined the name, cannot be reached
// the same way: it holds one text node, so there is no child to paint. Naming
// both of its classes is what wins instead — two classes outrank the single
// `.cm-tooltip` a theme states, and specificity is settled before the order the
// rules were added in.
const theme = legible('.cm-tooltip-autocomplete > ul', '.cm-tooltip.cm-completionInfo');

/**
 * The names in scope where the cursor is.
 *
 * Added as language data rather than as a completion source of its own, so a
 * host with more to offer — a standard library, snippets — adds theirs beside
 * it and both appear.
 */
export function completions(config: Resolved): Extension {
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
          config.initialScope,
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
