// A page for looking at the package on its own.
//
// Deliberately not the playground: no compiler, no worker, no site around it.
// What is on screen is a stock CodeMirror editor plus this package's one
// extension, `lambada()` — today that is the grammar and nothing else.
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

// What the page asks the package for. No options exist yet, so: nothing.
const config: LambadaConfig = {};

// Whether a theme is loaded alongside. Not the package's to provide, but the
// grammar marks more than CodeMirror's default highlight style paints, so
// without one the editor understates what `lambada()` already knows — hence on
// by default. The checkbox holds that default, so it is stated in one place.
const loadTheme = document.querySelector<HTMLInputElement>('#load-theme')!;
let themed = loadTheme.checked;

const prefersDark = matchMedia('(prefers-color-scheme: dark)');
// The header's switch owns the page's theme; the editor follows it.
const isDark = () =>
  (document.documentElement.dataset.theme ||
    (prefersDark.matches ? 'dark' : 'light')) === 'dark';

const themeName = () => (isDark() ? 'basicDark' : 'basicLight');
const themePackage = () => `cm6-theme-basic-${isDark() ? 'dark' : 'light'}`;

// A compartment so toggling reconfigures the editor in place rather than
// rebuilding it, which would lose the cursor and any edits made to the sample.
const theme = new Compartment();
const themeExtension = () => (themed ? (isDark() ? basicDark : basicLight) : []);

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
  extensions: [basicSetup, lambada(config), theme.of(themeExtension())],
  parent: document.querySelector('#editor')!,
});

function render() {
  view.dispatch({ effects: theme.reconfigure(themeExtension()) });
  document.querySelector('#snippet')!.textContent = snippet();
  const options = Object.keys(config);
  document.querySelector('#status')!.textContent = options.length
    ? `lambada() with ${options.join(', ')}`
    : 'lambada() with no options — the grammar, and nothing else yet';
}

loadTheme.addEventListener('change', () => {
  themed = loadTheme.checked;
  render();
});

// Both ways the page's theme can change: the header's switch writes the
// attribute, and the system setting moves when the switch has not been used.
new MutationObserver(render).observe(document.documentElement, {
  attributeFilter: ['data-theme'],
});
prefersDark.addEventListener('change', render);

render();
