import { Prec, type Extension } from '@codemirror/state';
import { keymap, type Command } from '@codemirror/view';

// The tree node operator. `t` is the language's alias for it, so these keys are
// a convenience rather than the only way to write one.
const node = '△';

// Four bindings for one insertion, because which of them reaches the page
// depends on the OS and the browser: `Alt-` is a dead-key prefix under some
// keyboard layouts, and `Ctrl-n` opens a window in some browsers. A host that
// knows what it is running on can name one key instead — `Mod-t`, say.
export const defaultNodeKeys = ['Alt-t', 'Alt-n', 'Ctrl-t', 'Ctrl-n'];

/**
 * Insert `△` at the cursor.
 *
 * Exported as well as bound, because a key is not the only way to ask for one:
 * a touch keyboard has no `Alt` to hold, so a page meant to be used on a phone
 * needs a button, and a button needs the same insertion the keys make.
 */
export const insertNode: Command = ({ state, dispatch }) => {
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
export const nodeKeymap = (keys: readonly string[]): Extension =>
  keys.length
    ? Prec.highest(keymap.of(keys.map((key) => ({ key, run: insertNode }))))
    : [];
