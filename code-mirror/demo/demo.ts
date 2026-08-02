// A page for looking at the package on its own.
//
// Deliberately not the playground: no compiler, no worker, no site around it.
// What is on screen is a stock CodeMirror editor plus this package's one
// extension, `lambada()` — today that is the grammar and nothing else, so the
// colours are CodeMirror's own default highlight style rather than ours.
//
// The two things below are meant to stay in step: `config` is what the page
// asks the package for, and the snippet beside it is the code a host would
// write to ask for the same. When there are controls, they will edit `config`,
// and both the editor and the snippet will follow.

import { EditorView, basicSetup } from 'codemirror';

import { lambada, type LambadaConfig } from '../src/index';
import { sample } from './sample';

// What the page asks the package for. No options exist yet, so: nothing.
const config: LambadaConfig = {};

function snippet(config: LambadaConfig): string {
  const options = Object.entries(config).map(
    ([key, value]) => `      ${key}: ${JSON.stringify(value)},`,
  );
  const argument = options.length ? `{\n${options.join('\n')}\n    }` : '';
  return `import { EditorView, basicSetup } from 'codemirror';
import { lambada } from '@lambada-llc/codemirror-lang-lambada';

new EditorView({
  doc,
  extensions: [
    basicSetup,
    lambada(${argument}),
  ],
  parent: document.querySelector('#editor'),
});
`;
}

new EditorView({
  doc: sample,
  extensions: [basicSetup, lambada(config)],
  parent: document.querySelector('#editor')!,
});

const options = Object.keys(config);
document.querySelector('#snippet')!.textContent = snippet(config);
document.querySelector('#status')!.textContent = options.length
  ? `lambada() with ${options.join(', ')}`
  : 'lambada() with no options — the grammar, and nothing else yet';
