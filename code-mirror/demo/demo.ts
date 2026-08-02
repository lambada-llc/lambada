// A page for looking at the package on its own.
//
// Deliberately not the playground: no compiler, no worker, no site around it.
// What is on screen is a stock CodeMirror editor plus whatever this package
// puts into it — which today is nothing, so the editor is the baseline against
// which everything added later can be seen.
//
// The two things below are meant to stay in step: `loaded` is what the package
// contributes to the editor, and the snippet under it is that same list written
// out as the code a host would have to write to get it. When there are controls,
// they will change `loaded`, and both the editor and the snippet will follow.

import { EditorView, basicSetup } from 'codemirror';

import { sample } from './sample';

// What this package contributes to the editor. Empty until there is something
// to contribute.
const loaded: readonly string[] = [];

function snippet(extensions: readonly string[]): string {
  const ours = extensions.length
    ? `import { ${extensions.map((e) => e.replace(/\(.*$/, '')).join(', ')} } from '@lambada-llc/code-mirror';\n`
    : '';
  const lines = ['basicSetup', ...extensions].map((e) => `    ${e},`).join('\n');
  return `import { EditorView, basicSetup } from 'codemirror';
${ours}
new EditorView({
  doc,
  extensions: [
${lines}
  ],
  parent: document.querySelector('#editor'),
});
`;
}

new EditorView({
  doc: sample,
  extensions: [basicSetup],
  parent: document.querySelector('#editor')!,
});

document.querySelector('#snippet')!.textContent = snippet(loaded);
document.querySelector('#status')!.textContent = loaded.length
  ? `${loaded.length} extension(s) from the package`
  : 'nothing from the package is loaded';
