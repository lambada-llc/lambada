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

## Colours

CodeMirror's own style leaves the grammar's brackets and operators unpainted, so
with nothing but `basicSetup` they come out the colour of the surrounding text.
Any theme fills them in; the demo loads
[cm6-themes](https://github.com/craftzdog/cm6-themes) and has a switch for
turning it off to see the difference.

## Occurrences

Put the cursor in a name and every occurrence that means the same thing
lights up. The editor understands scope: on a lambda's parameter, that is the
parameter's own uses; on a definition, or on any use of one, it is the
definition together with the uses it governs — redefining a name starts a
fresh group, exactly as it starts a fresh meaning.

``` ts
lambada({ highlightSymbols: false })              // do not highlight occurrences
```

Selecting text still searches for the text, as CodeMirror always has; the
resting cursor is what finds meaning. None of this needs a compilation, so an
editor configured with `compile: false` highlights all the same.

## Compilation

`lambada()` compiles each statement and marks it — green when it compiled, red
when it did not. The compiler ships with the package, so this needs no setting
up.

It also reports names a statement uses that nothing has defined, under the word
itself, offers the names that *are* in scope as completions, and evaluates the
statements that are expressions rather than definitions, previewing what each
came out as.

``` ts
lambada({ compile: false })                       // the editing support alone
lambada({ compile: { showStatus: false } })       // compile, but do not mark
lambada({ compile: { showDiagnostics: false } })  // mark, but do not report names
lambada({ compile: { showCompletions: false } })  // do not offer names
lambada({ compile: { previewResults: false } })   // do not evaluate anything
lambada({ compile: { previewResults: show } })    // what to show for a value
lambada({ compile: { compiler, timeout } })       // a compiler of your own
lambada({ compile: { environment } })             // what is in scope to begin with
lambada({ compile: { gotoDefinition: false } })   // do not offer jumps
lambada({ compile: { gotoDefinition:              // where environment names live
    { external: (name) => ... } } })
```

Ctrl-click a name (Cmd on a Mac), or press F12 on it, to jump to its
definition. A name a statement above defines is jumped to in place. A name the
*environment* defines is somewhere this package cannot see — a page, a file, a
repository — so the host says: `external` is asked for the action that goes to
a name's definition, and returns null for one it has nowhere to send. It is
asked before a jump is offered — the underline under the pointer while the
modifier is held — so only names with somewhere to go invite the click, and it
should be cheap.

What a click refers to is read off the compilation, not guessed from the text:
the compiler this package ships annotates what it emits with source spans, so
a shadowed name goes to the definition that counts and a lambda's own
parameter goes nowhere. That is also why the option lives inside `compile` —
without a compilation there is nothing to resolve.

Completions arrive as language data, so a host with more to offer — a standard
library, snippets — adds a source of its own and both appear.

`previewResults` is handed the value as a `Tree` and returns what to show for
it: a string, or an element and how much room to keep for it. Nothing is read
into a tree by default — it is written out as itself, `△ (△ △) △`, since what a
value means is the host's to know. `dagOf(tree)` is how one leaves the page:
a `Tree` is live objects, and a
[DAG](https://github.com/lambada-llc/tree-calculus/blob/main/conventions/README.md#dag-directed-acyclic-graph)
is text, so it can go into a link, a file, or a frame that renders it.

Evaluating happens on a second worker. A compilation takes single-digit
milliseconds and an evaluation need never finish, so sharing one would let a
program that loops hold up the marks, the reported names and the completions
for everything else.

`environment` is a [DAG module](https://github.com/lambada-llc/tree-calculus/blob/main/conventions/README.md#dag-modules):
whatever it defines is in scope before the document starts. It is empty by
default, leaving `△` as the only bound symbol. A host with a standard library
passes it here — a record literal, for one, needs a `Map.set` that nothing
defines otherwise.

Everything that reads a compilation is configured inside `compile` rather than
beside it, because none of it means anything without one — the marks, the names
reported and offered, and the values.

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