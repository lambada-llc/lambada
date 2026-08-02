A [CodeMirror 6](https://codemirror.net/) editing package for LambAda.

# [→ Try it in your browser](https://lambada-llc.github.io/lambada/)

``` ts
import { EditorView, basicSetup } from 'codemirror';
import { lambada } from '@lambada-llc/codemirror-lang-lambada';

new EditorView({
  doc,
  extensions: [
    basicSetup,
    lambada(/* configuration */)
  ],
  parent: document.querySelector('#editor'),
});
```

The demo page displays an editor alongside the code that produces it. This lets
you compare stock CodeMirror to what `lambada()` (from [`src/index.ts`](./src/index.ts)) adds, one option at a time.

## Compilation

`lambada()` compiles each statement and marks it — green when it compiled, red
when it did not. The compiler ships with the package, so this needs no setting
up; pass `compile: false` for the editing support alone, or `compile: {…}` to
supply a compiler of your own.

It runs on a worker started from a `blob:` URL. That is what lets the same
build work whether you bundle this package or serve it as files — the worker
source has no imports, so there is nothing for a bundler or an import map to
resolve, and import maps do not reach workers in any case. Killing that worker
is also the only way to stop a compilation that will not finish: evaluating a
tree is one synchronous loop.

**If you send a `Content-Security-Policy`, it has to allow `blob:` workers** —
`worker-src`, `child-src` or `script-src` will each do it. Without that the
editor still works, nothing is marked, and the reason is logged once.

## Running it yourself

``` bash
npm install
npm run dev         # the demo, served
npm run build       # both of the below
npm run build:lib   # the library, written to dist/
npm run build:demo  # the demo page, written to demo-dist/
```

Vite wants Node 20.19+, hence the [`.nvmrc`](./.nvmrc).