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

An expression that evaluates to a [file](https://github.com/lambada-llc/tree-calculus/tree/main/conventions#files) — `△ (△ <name> <media type>) <bytes>` — is written into a sibling `expect-test-out/` directory instead, and the comment identifies it by name and content hash:

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
| `compile` | Compile every `.lamb` file under the root into a sibling `.<name>.dag` module, namespaced by where it lives. Modules from a previous run are removed first, so a deleted source leaves nothing behind. |
| `expect-test <bundle>` | Evaluate the tests in a linked, canonicalized bundle and record each result in the source it came from. |

| Option | |
| --- | --- |
| `--root <dir>` | Where the sources live. Defaults to `src`. |
| `--cache <dir>` | Where to memoize compiled chunks. Compiling is a pure function of the chunk and the compiler, so a rebuild only pays for what actually changed, and changing the compiler correctly invalidates everything. Defaults to `.cache/lambada`. |
| `--compiler <file>` | The compiler to use, as a `.dag`. Defaults to the one shipped in [`compiler/`](../compiler/). |
| `--tree-calculus <path>` | A [tree-calculus](https://github.com/lambada-llc/tree-calculus) checkout to use, instead of downloading the published runtime. Also settable as `$LAMBADA_TREE_CALCULUS`. |

Compiling produces one [DAG module](https://github.com/lambada-llc/tree-calculus/tree/main/conventions#dag-modules) per source. Putting those together into one program is [`dag.js`](https://github.com/lambada-llc/tree-calculus/tree/main/bin)'s job, so a full build is:

``` bash
lambada.js compile
dag.js link $(find src -name '.*.dag' | sort) | dag.js canonicalize > bundle.dag
lambada.js expect-test bundle.dag
```

See [arboretum](https://github.com/lambada-llc/arboretum) for a repository built exactly this way.

## Layout

| | |
| --- | --- |
| `lambada.js` | Command line entry point. |
| `project.js` | What a directory of LambAda sources means: how a source splits into compilable chunks, and how a path becomes a namespace and back. |
| `compile.js` | Applying the compiler to each chunk and namespacing the result. |
| `expect-test.js` | Evaluating tests and writing results back into sources. |
| `runtime.js` | Locating the tree calculus runtime. |
| `test.js` | Tests for the conventions in `project.js` (what CI runs). |
