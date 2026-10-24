#!/usr/bin/env node
'use strict';

// Build tool for projects written in LambAda. See README.md in this directory.
//
// Everything specific to LambAda lives here: how a file's location becomes a
// namespace, and what an expect test looks like in a source file. How a source
// splits into statements is the compiler's own business. Putting the resulting DAG modules
// together into a program is the tree calculus runtime's job — see
// https://github.com/lambada-llc/tree-calculus/tree/main/bin

const { availableParallelism, totalmem } = require('os');
const { resolve } = require('path');
const { load } = require('./runtime.js');

const COMPILER = resolve(__dirname, '../compiler/compile_file.dag');
const PRELUDE = resolve(__dirname, '../compiler/prelude.dag');

// A reducer per thread, each granted 3 GB: one peaks at about 1.1 GB under the
// runner's default collection threshold. Memory is the container's limit where
// one is set: inside a container, totalmem() reports the host's.
const JOBS = Math.max(1, Math.min(availableParallelism(),
  Math.floor(Math.min(totalmem(), process.constrainedMemory() || Infinity) / 3 / 2 ** 30)));

const USAGE = `Usage: lambada <command> [options]

Commands:
  build [--root <dir>] [--library <dir>]... [--out <name>]
                                Compile, link and test in one go: every library
                                (compiled under its own root, linked without its
                                tests), then the sources under <dir>, writing
                                <dir>/.dag-bundle-linked and
                                <dir>/.dag-bundle-canonical along the way.
  compile [--root <dir>]        Compile every .lamb file under <dir> into a
                                sibling .<name>.dag module, namespaced by where
                                it lives. Modules from a previous run are removed
                                first, so a deleted source leaves nothing behind.
  expect-test <bundle> [--root <dir>] [--out <name>]
                                Evaluate the tests in a linked, canonicalized
                                bundle and record each result as a '# = …'
                                comment below the expression it belongs to, or
                                a file in an <name>/ beside its source.
  emit [file]                   One source as the compiler emits it, after the
                                prelude, on standard output, nothing named or
                                qualified. Reads stdin without
                                a file. For a snippet to run against a library,
                                or to see what the compiler makes of a file.

Options:
  --root <dir>          Where the sources live. Defaults to src.
  --out <name>          The directory, beside each source, that its tests'
                        files are written to. Defaults to out. Machine-owned:
                        a file in it no test wrote is removed.
  --library <dir>       A directory of sources to build against, for build.
                        Repeat it for several.
  --jobs <n>            Compile this many sources, or evaluate this many tests,
                        at once, each in a thread with a reducer of its own.
                        Defaults to one per core, as far as 3 GB each goes.
  --compiler <file>     The compiler to use, as a .dag: a function from a
                        whole source's text to its DAG. Defaults to the one
                        shipped in compiler/.
  --prelude <file>      The combinator definitions compiled code refers to,
                        as .dag lines, put at the top of each module. Belongs to
                        the compiler that emits those references; defaults to the
                        one shipped beside it.
  --tree-calculus <path>
                        A tree-calculus checkout to use, instead of downloading
                        the published runtime. Also settable as
                        $LAMBADA_TREE_CALCULUS.

build is the steps below; between compile and expect-test, link and
canonicalize the modules with dag.js:

  lambada compile
  dag.js link $(find src -name '.*.dag' | sort) | dag.js canonicalize > bundle.dag
  lambada expect-test bundle.dag

The runtime keeps what it computes in its cache: compiled sources, so a rebuild
compiles only those that changed, and test results, so a rerun evaluates only
the tests whose terms changed.`;

function parse_args(argv) {
  const command = argv[0];
  const positional = [];
  const options = { libraries: [] };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${arg} needs a value`);
      return argv[++i];
    };
    if (arg === '--root') options.root = value();
    else if (arg === '--out') options.out = value();
    else if (arg === '--library') options.libraries.push(value());
    else if (arg === '--jobs') options.jobs = Number(value());
    else if (arg === '--compiler') options.compiler = value();
    else if (arg === '--prelude') options.prelude = value();
    else if (arg === '--tree-calculus') options.tree_calculus = value();
    else if (arg.startsWith('--')) throw new Error(`unrecognized option ${arg}`);
    else positional.push(arg);
  }
  return { command, positional, options };
}

async function main(argv) {
  if (!argv.length || argv[0] === '-h' || argv[0] === '--help') {
    console.log(USAGE);
    return;
  }

  const { command, positional, options } = parse_args(argv);
  if (!['build', 'compile', 'expect-test', 'emit'].includes(command)) {
    throw new Error(`unrecognized command ${command}`);
  }

  // Only now, so that a mistyped command does not go looking for a runtime.
  const runtime = load(options.tree_calculus);
  const root = options.root ?? 'src';

  switch (command) {
    case 'build':
      await require('./build.js').build({
        runtime,
        root,
        libraries: options.libraries,
        out: options.out,
        compiler: options.compiler ?? COMPILER,
        prelude: options.prelude ?? PRELUDE,
        cwd: process.cwd(),
        jobs: options.jobs ?? JOBS,
        tree_calculus: options.tree_calculus,
      });
      break;

    case 'compile':
      await require('./compile.js').compile({
        runtime,
        root,
        compiler: options.compiler ?? COMPILER,
        prelude: options.prelude ?? PRELUDE,
        cwd: process.cwd(),
        jobs: options.jobs ?? JOBS,
        tree_calculus: options.tree_calculus,
      });
      break;

    case 'emit': {
      const file = positional[0] ?? '-';
      const source = require('fs').readFileSync(file === '-' ? 0 : file, 'utf8');
      process.stdout.write(require('./compile.js').emit({
        runtime,
        compiler: options.compiler ?? COMPILER,
        prelude: options.prelude ?? PRELUDE,
        source,
        where: file,
      }));
      break;
    }

    case 'expect-test': {
      if (!positional.length) throw new Error('expect-test needs a bundle to evaluate');
      await require('./expect-test.js').expect_test({
        runtime,
        root,
        out: options.out,
        bundle_path: positional[0],
        jobs: options.jobs ?? JOBS,
        tree_calculus: options.tree_calculus,
      });
      break;
    }
  }
}

main(process.argv.slice(2)).catch(error => {
  console.error(`lambada: ${error.message}`);
  process.exit(1);
});
