import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

/**
 * A tooltip that stays legible whatever theme the host loaded.
 *
 * A theme that picks its background from the wrong end of its own palette
 * leaves the text in a tooltip unreadable — dark on dark, or light on light.
 * Stating both colours on the tooltip itself is what keeps it readable whatever
 * is around it. `&light` and `&dark` follow the editor's own theme rather than
 * the page's, and a base theme is what a host that does style these still wins
 * over.
 *
 * A selector for a tooltip *root* has to name both of its classes —
 * `.cm-tooltip.cm-thing` — or a theme's own `.cm-tooltip` background outranks
 * it and the colours end up from two different palettes; see the
 * completion-info selector, and the chip's. A child of a tooltip
 * (the completion list) escapes that by covering what is behind it.
 *
 * One theme per call rather than one for all of them, so that an extension left
 * out takes its colours with it.
 */
export const legible = (...selectors: readonly string[]): Extension =>
  EditorView.baseTheme({
    [selectors.map((selector) => `&light ${selector}`).join(', ')]: {
      backgroundColor: '#f5f5f5',
      color: '#1c1c1c',
    },
    [selectors.map((selector) => `&dark ${selector}`).join(', ')]: {
      backgroundColor: '#2b2b2b',
      color: '#eeeeee',
    },
  });
