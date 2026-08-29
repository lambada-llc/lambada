import { syntaxTree } from '@codemirror/language';
import {
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  keymap,
  type Command,
  type DecorationSet,
} from '@codemirror/view';

import { type Statement } from './statements';
import { definitionSite, symbolAt, type Range } from './symbols';

// Go to definition, resolved by the same scope walk that highlights
// occurrences (see symbols.ts): a bound use jumps to its binder, a use of a
// definition to the statement that defines it, and a name the *environment*
// defines is handed to the host, whose page knows where such definitions
// live. No compilation is involved, so the jumps work while a statement is
// still compiling and in editors that never compile at all.

export interface GotoDefinitionConfig {
  /**
   * Where a name the *environment* defines is defined, as the action that
   * goes there — or null, where the host has nowhere to send the reader.
   * Asked before a jump is so much as offered (the underline, the pointer),
   * so it has to be cheap; the action itself runs on the click or key that
   * took the offer. Names the document defines never reach this: those jump
   * within the editor on their own.
   *
   * Nothing by default, which leaves every environment name unofferable.
   */
  external?: (name: string) => ((view: EditorView) => void) | null;
  /** Keys that jump at the cursor, in CodeMirror's notation. Default: F12. */
  keys?: readonly string[];
}

/** The configuration with its defaults filled in; null is off. */
export interface ResolvedGoto {
  external: NonNullable<GotoDefinitionConfig['external']>;
  keys: readonly string[];
}

export function resolveGoto(
  config: boolean | GotoDefinitionConfig,
): ResolvedGoto | null {
  if (config === false) return null;
  const given = config === true ? {} : config;
  return {
    external: given.external ?? (() => null),
    keys: given.keys ?? ['F12'],
  };
}

/** The first place `symbol` is written in this statement, if it is. */
export function writtenAt(
  state: EditorState,
  statement: Statement,
  symbol: string,
): { from: number; to: number } | null {
  let found: { from: number; to: number } | null = null;
  syntaxTree(state).iterate({
    from: statement.from,
    to: statement.to,
    enter(node) {
      if (found) return false;
      if (node.name !== 'Identifier' && node.name !== 'Binder') return;
      if (state.doc.sliceString(node.from, node.to) === symbol)
        found = { from: node.from, to: node.to };
      return;
    },
  });
  return found;
}

/** A use that leads somewhere: where it is written, and the going there. */
interface Jump {
  at: Range;
  go: (view: EditorView) => void;
}

const select = (pos: number) => (view: EditorView) => {
  view.dispatch({
    selection: { anchor: pos },
    effects: EditorView.scrollIntoView(pos, { y: 'center' }),
  });
  view.focus();
};

function jumpAt(
  state: EditorState,
  scope: ReadonlySet<string>,
  goto: ResolvedGoto,
  pos: number,
): Jump | null {
  const symbol = symbolAt(state, pos);
  if (!symbol) return null;

  if (symbol.kind === 'binding') {
    const binder = symbol.binding.ranges[0];
    // On the binder itself there is nowhere lefter to go.
    if (binder === symbol.at) return null;
    return { at: symbol.at, go: select(binder.from) };
  }

  if (symbol.governing) {
    const site = definitionSite(state, symbol.governing, symbol.name);
    if (!site || site.from === symbol.at.from) return null;
    return { at: symbol.at, go: select(site.from) };
  }

  // The host decides whether it has anywhere to send this name — asked
  // here, before anything is underlined, so what is offered is what works.
  if (!scope.has(symbol.name)) return null;
  const go = goto.external(symbol.name);
  return go && { at: symbol.at, go };
}

// ── the gesture ─────────────────────────────────────────────────────────────

const mac =
  typeof navigator !== 'undefined' && /Mac|iP[ao]d|iPhone/.test(navigator.platform);

/** The go-to-definition modifier: the one that adds cursors, borrowed only
 * where a jump actually resolves, so plain multi-cursor clicking survives. */
const modded = (event: MouseEvent | KeyboardEvent): boolean =>
  mac ? event.metaKey : event.ctrlKey;

const jumpMark = Decoration.mark({ class: 'cm-jump' });
const setJumpable = StateEffect.define<Range | null>();

/**
 * The underline shown while the modifier is down and the pointer is over a
 * use that leads somewhere. Held in the state so the handlers below only
 * ever say what changed.
 */
const jumpable = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const effect of tr.effects)
      if (effect.is(setJumpable))
        return effect.value
          ? Decoration.set([jumpMark.range(effect.value.from, effect.value.to)])
          : Decoration.none;
    // An edit under the pointer is answered by the next mousemove; until
    // then the old range means nothing.
    return tr.docChanged ? Decoration.none : deco;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const theme = EditorView.baseTheme({
  '.cm-jump': { textDecoration: 'underline', cursor: 'pointer' },
});

/**
 * Go to definition: the modifier-click, the underline that offers it, and a
 * key that jumps at the cursor.
 */
export function gotoDefinition(
  goto: ResolvedGoto,
  scope: ReadonlySet<string>,
): Extension {
  const show = (view: EditorView, at: Range | null) => {
    const current = view.state.field(jumpable);
    let unchanged = at === null && current === Decoration.none;
    current.between(0, view.state.doc.length, (from, to) => {
      unchanged = at !== null && from === at.from && to === at.to;
      return false;
    });
    if (!unchanged) view.dispatch({ effects: setJumpable.of(at) });
  };

  const jumpAtCursor: Command = (view) => {
    const jump = jumpAt(view.state, scope, goto, view.state.selection.main.head);
    if (!jump) return false;
    jump.go(view);
    return true;
  };

  return [
    jumpable,
    theme,
    keymap.of(goto.keys.map((key) => ({ key, run: jumpAtCursor }))),
    EditorView.domEventHandlers({
      mousedown(event, view) {
        if (event.button !== 0 || !modded(event) || event.shiftKey || event.altKey)
          return false;
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        const jump = pos === null ? null : jumpAt(view.state, scope, goto, pos);
        if (!jump) return false;
        show(view, null);
        jump.go(view);
        return true;
      },
      mousemove(event, view) {
        const at = modded(event)
          ? view.posAtCoords({ x: event.clientX, y: event.clientY })
          : null;
        show(view, at === null ? null : (jumpAt(view.state, scope, goto, at)?.at ?? null));
      },
      // Releasing the modifier takes the offer with it; `modded` is false on
      // the modifier's own keyup, since the flag reports the state after.
      keyup(event, view) {
        if (!modded(event)) show(view, null);
      },
      mouseleave(_event, view) {
        show(view, null);
      },
    }),
  ];
}
