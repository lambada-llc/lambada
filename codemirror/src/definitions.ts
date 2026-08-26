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

import { isOfferable } from './analysis';
import { lambadaCompilations } from './compilation';
import type { Resolved } from './config';
import { dagLine, spanned, type Span } from './dag';
import { chunkPos, docPos, lambadaStatements, type Statement } from './statements';

/** A use of a name, and where it is written. */
export interface Reference {
  /** The name referred to. */
  name: string;
  /** The occurrence, in document positions. */
  from: number;
  to: number;
}

export type Definition =
  /** Defined by a statement of this document; `pos` is where its name is written. */
  | { kind: 'statement'; statement: Statement; pos: number }
  /** Defined by the environment, which is the host's to know places for. */
  | { kind: 'environment'; name: string };

// The compiler counts code points — a string, to it, is its code points —
// where the document counts UTF-16 units. The two agree until a character
// beyond the basic plane appears, which is what the test is for: without one,
// both conversions are the identity.
const astral = /[\u{10000}-\u{10ffff}]/u;

function pointsAt(text: string, utf16: number): number {
  if (!astral.test(text)) return utf16;
  let points = 0;
  for (let i = 0; i < utf16; points++) i += text.codePointAt(i)! >= 0x10000 ? 2 : 1;
  return points;
}

function unitsAt(text: string, points: number): number {
  if (!astral.test(text)) return points;
  let i = 0;
  while (points-- > 0) i += text.codePointAt(i)! >= 0x10000 ? 2 : 1;
  return i;
}

/**
 * The reference at `pos`, read off the compiled spans: the innermost span
 * alias covering the position whose base is a name somebody writes and that
 * the line aliases to itself — which is exactly how the compiler emits an
 * identifier's occurrence. A bound variable emits no such alias — it lowers
 * into combinators and its name is gone — so what this finds is always a use
 * of a definition, never a lambda's own parameter.
 *
 * Nothing without a compilation: the spans are the compiler's answer, and
 * guessing from the tokens would happily send a shadowed or bound name to a
 * definition it does not mean.
 */
export function referenceAt(state: EditorState, pos: number): Reference | null {
  const statement = state
    .field(lambadaStatements)
    .find((s) => s.from <= pos && pos <= s.to);
  if (!statement) return null;
  const known = state.field(lambadaCompilations).get(statement.text);
  if (known?.status !== 'ok') return null;
  const at = chunkPos(statement, pos);
  if (at === null) return null;

  // A cursor sits between characters, so a boundary position means the name
  // on either side of it — which containment with both ends included says.
  const point = pointsAt(statement.text, at);
  let best: Span | null = null;
  for (const line of known.dagLines) {
    const { name, from } = dagLine(line);
    const span = spanned(name);
    if (!span || from.length !== 1 || from[0] !== span.base) continue;
    if (!isOfferable(span.base)) continue;
    if (span.from > point || point > span.to) continue;
    if (!best || span.to - span.from < best.to - best.from) best = span;
  }
  if (!best) return null;

  const from = docPos(statement, unitsAt(statement.text, best.from));
  const to = docPos(statement, unitsAt(statement.text, best.to));
  if (from === null || to === null) return null;
  return { name: best.base, from, to };
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

/**
 * Where what `reference` names is defined: the nearest statement above it
 * that defines the name — the compiler's own rule, a definition hides any
 * previous meaning — or the environment, or nowhere at all, which is an
 * undefined name and the diagnostics' to report.
 */
export function definitionOf(
  state: EditorState,
  initialScope: ReadonlySet<string>,
  reference: Reference,
): Definition | null {
  const compilations = state.field(lambadaCompilations);
  let found: Statement | null = null;
  for (const statement of state.field(lambadaStatements)) {
    if (statement.to >= reference.from) break;
    const known = compilations.get(statement.text);
    if (known?.status !== 'ok') continue;
    for (const line of known.dagLines) {
      const { name, from } = dagLine(line);
      if (from.length === 1 && name === reference.name) found = statement;
    }
  }
  if (found) {
    const written = writtenAt(state, found, reference.name);
    return { kind: 'statement', statement: found, pos: written?.from ?? found.from };
  }
  return initialScope.has(reference.name)
    ? { kind: 'environment', name: reference.name }
    : null;
}

/** A reference that leads somewhere, and the going there. */
interface Jump {
  reference: Reference;
  go: (view: EditorView) => void;
}

function jumpAt(state: EditorState, config: Resolved, pos: number): Jump | null {
  const goto = config.goto;
  if (!goto) return null;
  const reference = referenceAt(state, pos);
  if (!reference) return null;
  const definition = definitionOf(state, config.initialScope, reference);
  if (!definition) return null;
  if (definition.kind === 'environment') {
    // The host decides whether it has anywhere to send this name — asked
    // here, before anything is underlined, so what is offered is what works.
    const go = goto.external(definition.name);
    return go ? { reference, go } : null;
  }
  const at = definition.pos;
  return {
    reference,
    go: (view) => {
      view.dispatch({
        selection: { anchor: at },
        effects: EditorView.scrollIntoView(at, { y: 'center' }),
      });
      view.focus();
    },
  };
}

// ── the gesture ─────────────────────────────────────────────────────────────

const mac =
  typeof navigator !== 'undefined' && /Mac|iP[ao]d|iPhone/.test(navigator.platform);

/** The go-to-definition modifier: the one that adds cursors, borrowed only
 * where a jump actually resolves, so plain multi-cursor clicking survives. */
const modded = (event: MouseEvent | KeyboardEvent): boolean =>
  mac ? event.metaKey : event.ctrlKey;

const jumpMark = Decoration.mark({ class: 'cm-jump' });
const setJumpable = StateEffect.define<Reference | null>();

/**
 * The underline shown while the modifier is down and the pointer is over a
 * reference that leads somewhere. Held in the state so the handlers below
 * only ever say what changed.
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
 * key that jumps at the cursor. In-document definitions are jumped to here;
 * a name the environment defines is handed to the host, whose page knows
 * where such definitions live — see `external` in [GotoDefinitionConfig].
 */
export function gotoDefinition(config: Resolved): Extension {
  const show = (view: EditorView, reference: Reference | null) => {
    const current = view.state.field(jumpable);
    let unchanged = reference === null && current === Decoration.none;
    current.between(0, view.state.doc.length, (from, to) => {
      unchanged = reference !== null && from === reference.from && to === reference.to;
      return false;
    });
    if (!unchanged) view.dispatch({ effects: setJumpable.of(reference) });
  };

  const jumpAtCursor: Command = (view) => {
    const jump = jumpAt(view.state, config, view.state.selection.main.head);
    if (!jump) return false;
    jump.go(view);
    return true;
  };

  return [
    jumpable,
    theme,
    keymap.of(config.goto!.keys.map((key) => ({ key, run: jumpAtCursor }))),
    EditorView.domEventHandlers({
      mousedown(event, view) {
        if (event.button !== 0 || !modded(event) || event.shiftKey || event.altKey)
          return false;
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        const jump = pos === null ? null : jumpAt(view.state, config, pos);
        if (!jump) return false;
        show(view, null);
        jump.go(view);
        return true;
      },
      mousemove(event, view) {
        const at = modded(event)
          ? view.posAtCoords({ x: event.clientX, y: event.clientY })
          : null;
        show(view, at === null ? null : (jumpAt(view.state, config, at)?.reference ?? null));
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
