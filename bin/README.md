`lambada.js` is a build tool for projects written in LambAda. It only requires [Node.js](https://nodejs.org/en) to be installed.

Where [`compiler/compile.sh`](../compiler/) compiles one expression against one file of definitions, this builds a whole directory of sources at once, works out how they depend on each other, and runs their tests.

## Projects

A project is a directory tree of `.lamb` files with no import statements. Symbols are namespaced by where they live and resolved automatically, so `src/bool/bool.lamb` defining `not` exports `Bool.not`, which any other file may use. Only dependency cycles are rejected. Files directly in the root export unqualified.

Adding a definition means dropping a file into the tree; nothing has to be registered anywhere.

## Expect tests

Every bare top-level expression is an [expect test](https://blog.janestreet.com/the-joy-of-expect-tests/). `expect-test` records its result as a `# = …` comment right below it:

```
# src/bool/bool.lamb
_to_string = to_source
not false
# = true
not true
# = false
```

If the file defines `_to_string`, it is applied to the result before rendering; otherwise identity is assumed. Only `# = ` lines and their `#   ` continuations are machine-owned — your own comments are left alone, and multi-line results wrap onto the continuation lines.

An expression that evaluates to a [file](https://github.com/lambada-llc/tree-calculus/tree/main/conventions#files) — `△ (△ <name> <media type>) <bytes>` — is written into a sibling `out/` directory instead (`--out` names another), and the comment identifies it by name and content hash:

```
# src/expect_test.lamb
file "hello.txt" "text/plain" "Hello, LambAda!"
# = hello.txt sha256:169f0107cf1f…
```

Results are placed by line, so they are only ever written into the sources the bundle was compiled from: compiling fingerprints each source's code lines into its module, and `expect-test` fails outright on a source that has changed since, rather than commenting it in the wrong places. Comments and blank lines are not part of that fingerprint — writing results back is not a change.

The test signal is the diff, not an exit code: `lambada expect-test` succeeds either way, and a changed source is either a bug to fix or an intentional change to review and commit. An unnoticed diff is a test failure.

## Usage

```
$ ./lambada.js <command> [options]
```

| Command | |
| --- | --- |
| `build` | All of the below in one go: compile each `--library` under its own root and link it without its tests, compile the sources under the root, link them against the libraries into `<root>/.dag-bundle-linked`, canonicalize that into `<root>/.dag-bundle-canonical`, and run the tests. |
| `compile` | Compile every `.lamb` file under the root into a sibling `.<name>.dag` module, namespaced by where it lives. Modules from a previous run are removed first, so a deleted source leaves nothing behind. Each compiled source is kept in the runtime's cache, keyed by the source and the compiler, so a rebuild compiles only the sources that changed, and changing the compiler correctly invalidates everything. |
| `expect-test <bundle>` | Evaluate the tests in a linked, canonicalized bundle and record each result in the source it came from. A bundle that is linked but not canonicalized is refused. Each result is kept in the runtime's cache under the fingerprint of its test's term, so a rerun evaluates only the tests whose terms changed. |
| `emit [file]` | One source as the compiler emits it, after the prelude, on standard output, nothing named or qualified. Reads stdin without a file. For a snippet to run against a library, or to see what the compiler makes of a file. |
| `repl [file]...` | An interactive session against the given DAG files, linked into one environment, with any `.lamb` sources among them loaded into it — see [The repl](#the-repl). |

| Option | |
| --- | --- |
| `--root <dir>` | Where the sources live. Defaults to `src`. |
| `--library <dir>` | A directory of sources `build` builds against, its names qualified under it as its own build would. Repeat it for several. |
| `--out <name>` | The directory beside each source that its tests' files go to. Defaults to `out`. Machine-owned: a file there that no test wrote is removed, and a source there is refused. |
| `--jobs <n>` | Compile this many sources, or evaluate this many tests, at once, each in a thread with a reducer of its own. Defaults to one per core, as far as 3 GB each goes: a reducer peaks at about 1.1 GB under the runner's default collection threshold. |
| `--compiler <file>` | The compiler to use, as a `.dag`: a function from a whole source's text to its DAG, like `compile_file`. Defaults to the one shipped in [`compiler/`](../compiler/). |
| `--prelude <file>` | The combinator definitions compiled code refers to, as `.dag` lines, put at the top of each module. They belong to the compiler that emits those references, so a project passing its own `compiler` passes its prelude too. Defaults to the one shipped beside it. |
| `--tree-calculus <path>` | A [tree-calculus](https://github.com/lambada-llc/tree-calculus) checkout to use, instead of downloading the published runtime. Also settable as `$LAMBADA_TREE_CALCULUS`. |
| `--eval`, `-e <source>` | For `repl`: evaluate this and exit, instead of reading input. Repeat it for several, in order. |
| `--format <f>` | For `repl`: how a result is shown when the session does not define `_to_string`: `term` (the default), `nat`, `string`, `bool`, `ternary`, `dag` or `minbin`. |
| `--timeout <s>` | For `repl`: stop an expression that runs longer than this many seconds, and carry on with the next. |

Compiling produces one [DAG module](https://github.com/lambada-llc/tree-calculus/tree/main/conventions#dag-modules) per source. Putting those together into one program is [`dag.js`](https://github.com/lambada-llc/tree-calculus/tree/main/bin)'s job, so `build` without libraries is:

``` bash
lambada.js compile
dag.js link $(find src -name '.*.dag' | sort) > src/.dag-bundle-linked
dag.js canonicalize src/.dag-bundle-linked > src/.dag-bundle-canonical
lambada.js expect-test src/.dag-bundle-canonical
```

A project using [arboretum](https://github.com/lambada-llc/arboretum) as its standard library builds with

``` bash
lambada.js build --library submodules/arboretum/src
```

## The repl

`repl` evaluates LambAda against an environment of DAG files: a project's `.dag-bundle-canonical`, a library's modules, anything `dag.js link` takes. Several are linked into one. `.lamb` sources given alongside are then loaded in order, as `:load` would.

```
$ lambada.js repl src/.dag-bundle-canonical
λ> double = \x Nat.add x x
λ> _to_string = List.to_source Nat.to_source
λ> List.map double [1, 2, 3]
[2; 4; 6]
```

A session is a source that grows: each input is compiled after the ones before it, so its definitions stay in scope and a later one hides an earlier one, as in a file. Each new bare expression is evaluated and shown — through `_to_string` when the session defines one, as an expect test is, and otherwise in `--format`. A file is described rather than printed. A name the input uses that nothing defines is reported before anything runs, and a statement that does not compile is named by the input's own line.

Evaluation runs in a thread of its own, so Ctrl-C (or `--timeout`) stops a term that does not finish without losing the session.

An input whose last statement does not compile yet continues on an indented line, as a statement does in a source, until it compiles or an empty line ends it. Alt-Enter starts a new line without running the input, and a pasted block runs as one input. `:load <file>` runs a `.lamb` source as an input, or links any other file into the environment as a DAG. `:undo [n]` takes back the last input or `:load`, or the last n: the session is a stack of those steps, and what remains is the state it returns to. `:names <prefix>` lists the environment's names, `:format` and `:quit` do what they say, and `:help` lists them.

Not at a terminal — with `--eval`, or input piped in — it shows each expression's result on standard output, reports problems on standard error, and exits with status 1 if there were any:

``` bash
echo 'Nat.mul 6 7' | lambada.js repl src/.dag-bundle-canonical --format nat
```

## Layout

| | |
| --- | --- |
| `lambada.js` | Command line entry point. |
| `build.js` | `compile`, linking against libraries, and `expect-test`, in one go. |
| `project.js` | What a directory of LambAda sources means: how a path becomes a namespace and back, and which lines of a source are code. |
| `compile.js` | Applying the compiler to each source and namespacing the result. |
| `expect-test.js` | Evaluating tests and writing results back into sources. |
| `repl.js` | The interactive session. |
| `runtime.js` | Locating the tree calculus runtime. |
| `test.js` | Tests for the conventions in `project.js`, the repl, and that the playground's [snippets](../examples/snippets/) need nothing but `△` and the ones before them (what CI runs). |
