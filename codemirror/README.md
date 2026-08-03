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
up.

It also reports names a statement uses that nothing has defined, under the word
itself, offers the names that *are* in scope as completions, and evaluates the
statements that are expressions rather than definitions — showing what each
comes to at the end of its line.

``` ts
lambada({ compile: false })                       // the editing support alone
lambada({ compile: { showStatus: false } })       // compile, but do not mark
lambada({ compile: { showDiagnostics: false } })  // mark, but do not report names
lambada({ compile: { showCompletions: false } })  // do not offer names
lambada({ compile: { showPreviews: false } })     // do not evaluate anything
lambada({ compile: { compiler, timeout } })       // a compiler of your own
lambada({ compile: { environment } })             // what is in scope to begin with
```

Completions arrive as language data, so a host with more to offer — a standard
library, snippets — adds a source of its own and both appear.

Evaluating happens on a second worker. A compilation takes single-digit
milliseconds and an evaluation need never finish, so sharing one would let a
program that loops hold up the marks, the reported names and the completions
for everything else.

`environment` is a [DAG module](https://github.com/lambada-llc/tree-calculus/blob/main/conventions/README.md#dag-modules):
whatever it defines is in scope before the document starts. The default defines
`t`, which is why that reads as a name rather than an unknown one. A host with a
standard library passes it here — a record literal, for one, needs a `Map.set`
that nothing defines otherwise.

Everything that reads a compilation is configured inside `compile` rather than
beside it, because none of it means anything without one — the marks today,
and later what a completion can know about the lines above it.

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