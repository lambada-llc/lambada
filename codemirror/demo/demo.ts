// A page for looking at the package on its own.
// Deliberately bare, just the editor and, in a second editor, the code that
// generates it.

import { EditorView, basicSetup } from 'codemirror';
import { indentWithTab } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import { Compartment, EditorState } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { basicDark } from 'cm6-theme-basic-dark';
import { basicLight } from 'cm6-theme-basic-light';

import { insertNode, lambada, type LambadaConfig } from '../src/index';
import { sample } from './sample';

// Try Alt-t, Alt-n, Ctrl-t or Ctrl-n in the editor. The box starts checked
// because the keys are on by default.
const nodeKeys = document.querySelector<HTMLInputElement>('#node-keys')!;

// Off writes `compile: false`, which takes the marks with it — the point of
// nesting them under `compile` is that they cannot be had separately.
const compile = document.querySelector<HTMLInputElement>('#compile')!;

// The three things a compilation is read for. All are on by default, so each
// box writes an option in when unchecked rather than out.
const diagnostics = document.querySelector<HTMLInputElement>('#diagnostics')!;
const completions = document.querySelector<HTMLInputElement>('#completions')!;
const previews = document.querySelector<HTMLInputElement>('#previews')!;

// Whether a theme is loaded alongside. Not the package's to provide, but the
// grammar marks more than CodeMirror's default highlight style paints, so
// without one the editor understates what `lambada()` already knows — hence on
// by default. The checkbox holds that default, so it is stated in one place.
const loadTheme = document.querySelector<HTMLInputElement>('#load-theme')!;

// What the page asks the package for, read off the boxes every time rather than
// kept alongside them. Empty is every default, which is why unchecking a box
// writes an option in rather than removing one: the snippet is what a host would
// have to type, and defaults are what you do not.
function currentConfig(): LambadaConfig {
  const config: LambadaConfig = {};
  if (!nodeKeys.checked) config.nodeKeys = false;
  if (!compile.checked) {
    config.compile = false;
    return config;
  }
  // Only worth writing when there is a compilation for them to read.
  const compileOptions: Exclude<LambadaConfig['compile'], boolean | undefined> = {};
  if (!diagnostics.checked) compileOptions.showDiagnostics = false;
  if (!completions.checked) compileOptions.showCompletions = false;
  if (!previews.checked) compileOptions.previewResults = false;
  if (Object.keys(compileOptions).length) config.compile = compileOptions;
  return config;
}

// The header's switch owns the page's theme, and writes it to the attribute the
// markup starts out carrying; the editor follows it.
const isDark = () => document.documentElement.dataset.theme === 'dark';

const themeName = () => (isDark() ? 'basicDark' : 'basicLight');
const themePackage = () => `cm6-theme-basic-${isDark() ? 'dark' : 'light'}`;

// A compartment each, so that toggling reconfigures the editor in place rather
// than rebuilding it, which would lose the cursor and any edits made to the
// sample. The parse tree survives too: a state field present in both the old
// and the new configuration keeps its value.
const theme = new Compartment();
const themeExtension = () =>
  loadTheme.checked ? (isDark() ? basicDark : basicLight) : [];

const language = new Compartment();

function snippet(config: LambadaConfig): string {
  const themed = loadTheme.checked;
  const asSource = (value: unknown, indent: string): string =>
    typeof value === 'object' && value !== null
      ? `{\n${Object.entries(value)
          .map(([k, v]) => `${indent}  ${k}: ${asSource(v, `${indent}  `)},`)
          .join('\n')}\n${indent}}`
      : JSON.stringify(value);
  const options = Object.entries(config).map(
    ([key, value]) => `      ${key}: ${asSource(value, '      ')},`,
  );
  const argument = options.length ? `{\n${options.join('\n')}\n    }` : '';
  return `import { EditorView, basicSetup } from 'codemirror';
import { indentWithTab } from '@codemirror/commands';
import { keymap } from '@codemirror/view';
import { lambada } from '@lambada-llc/codemirror-lang-lambada';
${themed ? `import { ${themeName()} } from '${themePackage()}';\n` : ''}
new EditorView({
  doc,
  extensions: [
    basicSetup,
    keymap.of([indentWithTab]),
    lambada(${argument}),${themed ? `\n    ${themeName()},` : ''}
  ],
  parent: document.querySelector('#editor'),
});
`;
}

const view = new EditorView({
  doc: sample,
  extensions: [
    basicSetup,
    keymap.of([indentWithTab]),
    language.of(lambada(currentConfig())),
    theme.of(themeExtension()),
  ],
  parent: document.querySelector('#editor')!,
});

// The snippet, in an editor rather than a <pre>: highlighted JavaScript, and
// under the same theme, so toggling it restyles both panes at once. Read-only
// twice over — `editable` keeps the caret out, `readOnly` stops the commands
// that would write — while the transactions below still get through, which is
// how the text follows the boxes. The compartment is shared with the editor
// above: a compartment is a key, and each state keeps its own value under it.
const snippetView = new EditorView({
  doc: snippet(currentConfig()),
  extensions: [
    basicSetup,
    javascript(),
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    theme.of(themeExtension()),
  ],
  parent: document.querySelector('#snippet')!,
});

function render() {
  const config = currentConfig();
  view.dispatch({
    effects: [
      language.reconfigure(lambada(config)),
      theme.reconfigure(themeExtension()),
    ],
  });
  const code = snippet(config);
  snippetView.dispatch({
    // Replaced only when it changed: this also runs for a theme flip, which
    // should not touch the text or where it is scrolled to.
    changes:
      code === snippetView.state.doc.toString()
        ? undefined
        : { from: 0, to: snippetView.state.doc.length, insert: code },
    effects: theme.reconfigure(themeExtension()),
  });
  for (const box of [diagnostics, completions, previews])
    box.disabled = !compile.checked;
}

for (const box of [nodeKeys, compile, diagnostics, completions, previews, loadTheme])
  box.addEventListener('change', render);

// Pressing a button would otherwise take the focus, and on a phone that closes
// the keyboard the button exists to make up for. Refused here, the editor never
// loses it, so the insertion lands where the cursor already was.
const nodeButton = document.querySelector<HTMLButtonElement>('#insert-node')!;
nodeButton.addEventListener('mousedown', (event) => event.preventDefault());
nodeButton.addEventListener('click', () => {
  insertNode(view);
  view.focus();
});

// The one way the page's theme can change: the header's switch writes the
// attribute.
new MutationObserver(render).observe(document.documentElement, {
  attributeFilter: ['data-theme'],
});

render();
