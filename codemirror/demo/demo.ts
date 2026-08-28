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
import { modules } from './environment';
import { inferred, size } from './preview';
import { sample } from './sample';

// Try Alt-t, Alt-n, Ctrl-t or Ctrl-n in the editor. The box starts checked
// because the keys are on by default.
const nodeKeys = document.querySelector<HTMLInputElement>('#node-keys')!;

// Put the cursor in a name — a lambda's parameter, a shadowed definition —
// and watch what lights up. Checked because the highlighting is on by default.
const highlightSymbols = document.querySelector<HTMLInputElement>('#highlight-symbols')!;

// Off writes `compile: false`, which takes the marks with it — the point of
// nesting them under `compile` is that they cannot be had separately.
const compile = document.querySelector<HTMLInputElement>('#compile')!;

// The three things a compilation is read for. All are on by default, so each
// box writes an option in when unchecked rather than out.
const diagnostics = document.querySelector<HTMLInputElement>('#diagnostics')!;
const completions = document.querySelector<HTMLInputElement>('#completions')!;
const previews = document.querySelector<HTMLInputElement>('#previews')!;

// What to show for a value. Each option is named after the function `./preview`
// exports for it, so the snippet can write one straight into an import — bar
// `tree`, which is the package's own default and imports nothing.
const previewMode = document.querySelector<HTMLSelectElement>('#preview-mode')!;
const previewOf = () =>
  previewMode.value === 'inferred'
    ? inferred
    : previewMode.value === 'size'
      ? size
      : undefined;

// A box per DAG module, built rather than written into the markup: the modules
// are whatever files are in `env-dags`, and a list kept by hand would sooner or
// later disagree with them. All on, because every one of them is used further
// down the sample.
const environment = document.querySelector<HTMLElement>('#environment')!;
const moduleBoxes = modules.map((module) => {
  const label = document.createElement('label');
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = true;
  label.append(box, module.name);
  environment.append(label);
  return { module, box };
});

/** The modules ticked on, in the order they would be concatenated. */
const chosen = () =>
  moduleBoxes.filter(({ box }) => box.checked).map(({ module }) => module);

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
  if (!highlightSymbols.checked) config.highlightSymbols = false;
  if (!compile.checked) {
    config.compile = false;
    return config;
  }
  // Only worth writing when there is a compilation for them to read.
  const compileOptions: Exclude<LambadaConfig['compile'], boolean | undefined> = {};
  if (!diagnostics.checked) compileOptions.showDiagnostics = false;
  if (!completions.checked) compileOptions.showCompletions = false;
  if (!previews.checked) compileOptions.previewResults = false;
  else {
    // Nothing to write for the tree itself, which is what the package does
    // when nobody says otherwise.
    const mode = previewOf();
    if (mode) compileOptions.previewResults = mode;
  }
  // Several of them simply concatenate — a DAG module is a list of definitions.
  const dag = chosen()
    .map((module) => module.dag)
    .join('\n');
  if (dag) compileOptions.environment = dag;
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
  // Both only reach the configuration through `compile`, so with compiling off
  // there is nothing to import for them either.
  const picked = compile.checked ? chosen() : [];
  // `tree` is the package's own default, which is written by writing nothing.
  const mode =
    compile.checked && previews.checked && previewMode.value !== 'tree'
      ? previewMode.value
      : '';

  // Two of the options have nothing worth reading as a value: an environment
  // is a hundred thousand lines of DAG, and a preview is a function. The
  // snippet names them instead, and the imports account for the names.
  const named: Record<string, string> = {};
  if (picked.length)
    named.environment =
      picked.length === 1
        ? picked[0].binding
        : `[${picked.map((module) => module.binding).join(', ')}].join('\\n')`;
  if (mode) named.previewResults = mode;

  const asSource = (key: string, value: unknown, indent: string): string =>
    named[key] ??
    (typeof value === 'object' && value !== null
      ? `{\n${Object.entries(value)
          .map(([k, v]) => `${indent}  ${k}: ${asSource(k, v, `${indent}  `)},`)
          .join('\n')}\n${indent}}`
      : JSON.stringify(value));
  const options = Object.entries(config).map(
    ([key, value]) => `      ${key}: ${asSource(key, value, '      ')},`,
  );
  const argument = options.length ? `{\n${options.join('\n')}\n    }` : '';

  const imports = [
    `import { EditorView, basicSetup } from 'codemirror';`,
    `import { indentWithTab } from '@codemirror/commands';`,
    `import { keymap } from '@codemirror/view';`,
    `import { lambada } from '@lambada-llc/codemirror-lang-lambada';`,
    ...(themed ? [`import { ${themeName()} } from '${themePackage()}';`] : []),
    ...(mode ? [`import { ${mode} } from './preview';`] : []),
    // Vite hands a file over as text for a `?raw` import; another bundler has
    // its own way of saying the same thing.
    ...picked.map((module) => `import ${module.binding} from '${module.path}?raw';`),
  ];

  return `${imports.join('\n')}

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
  // Everything that reads a compilation, and the modules there would be
  // nothing to compile them against.
  for (const control of [
    diagnostics,
    completions,
    previews,
    ...moduleBoxes.map(({ box }) => box),
  ])
    control.disabled = !compile.checked;
  previewMode.disabled = !compile.checked || !previews.checked;
}

for (const control of [
  nodeKeys,
  highlightSymbols,
  compile,
  diagnostics,
  completions,
  previews,
  previewMode,
  loadTheme,
  ...moduleBoxes.map(({ box }) => box),
])
  control.addEventListener('change', render);

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
