// A page for looking at the package on its own.
//
// Deliberately not the playground: no compiler, no worker, no site around it.
// What is on screen is a stock CodeMirror editor plus this package's one
// extension, `lambada()` — today the grammar and the keys that type `△`.
//
// The three things below are meant to stay in step: `config` is what the page
// asks the package for, `themed` is what it loads next to it, and the snippet
// beside them is the code a host would write to get the same editor.

import { EditorView, basicSetup } from 'codemirror';
import { Compartment } from '@codemirror/state';
import { basicDark } from 'cm6-theme-basic-dark';
import { basicLight } from 'cm6-theme-basic-light';

import { lambada, type LambadaConfig } from '../src/index';
import { sample } from './sample';

// What the page asks the package for. Left empty it is every default, which is
// why unchecking a box below writes an option in rather than removing one: the
// snippet is what a host would have to type, and defaults are what you do not.
const config: LambadaConfig = {};

// Try Alt-t, Alt-n, Ctrl-t or Ctrl-n in the editor. The box starts checked
// because the keys are on by default.
const nodeKeys = document.querySelector<HTMLInputElement>('#node-keys')!;

// Whether a theme is loaded alongside. Not the package's to provide, but the
// grammar marks more than CodeMirror's default highlight style paints, so
// without one the editor understates what `lambada()` already knows — hence on
// by default. The checkbox holds that default, so it is stated in one place.
const loadTheme = document.querySelector<HTMLInputElement>('#load-theme')!;
let themed = loadTheme.checked;

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
const themeExtension = () => (themed ? (isDark() ? basicDark : basicLight) : []);

const language = new Compartment();

function snippet(): string {
  const options = Object.entries(config).map(
    ([key, value]) => `      ${key}: ${JSON.stringify(value)},`,
  );
  const argument = options.length ? `{\n${options.join('\n')}\n    }` : '';
  return `import { EditorView, basicSetup } from 'codemirror';
import { lambada } from '@lambada-llc/codemirror-lang-lambada';
${themed ? `import { ${themeName()} } from '${themePackage()}';\n` : ''}
new EditorView({
  doc,
  extensions: [
    basicSetup,
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
    language.of(lambada(config)),
    theme.of(themeExtension()),
  ],
  parent: document.querySelector('#editor')!,
});

function render() {
  view.dispatch({
    effects: [
      language.reconfigure(lambada(config)),
      theme.reconfigure(themeExtension()),
    ],
  });
  document.querySelector('#snippet')!.textContent = snippet();
}

nodeKeys.addEventListener('change', () => {
  // Checked is the default, and a default is what a host would leave unwritten.
  if (nodeKeys.checked) delete config.nodeKeys;
  else config.nodeKeys = false;
  render();
});

loadTheme.addEventListener('change', () => {
  themed = loadTheme.checked;
  render();
});

// The one way the page's theme can change: the header's switch writes the
// attribute.
new MutationObserver(render).observe(document.documentElement, {
  attributeFilter: ['data-theme'],
});

render();
