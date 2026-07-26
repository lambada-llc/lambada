#!/usr/bin/env node
'use strict';

// Build tool for projects written in LambAda. See README.md in this directory.
//
// Everything specific to LambAda lives here: how a `.lamb` source splits into
// compilable chunks, how a file's location becomes a namespace, and what an
// expect test looks like in a source file. Putting the resulting DAG modules
// together into a program is the tree calculus runtime's job — see
// https://github.com/lambada-llc/tree-calculus/tree/main/bin

const { resolve } = require('path');
const { load } = require('./runtime.js');

const COMPILER = resolve(__dirname, '../compiler/compile_to_dag.dag');

const USAGE = `Usage: lambada <command> [options]

Commands:
  compile [--root <dir>]        Compile every .lamb file under <dir> into a
                                sibling .<name>.dag module, namespaced by where
                                it lives. Modules from a previous run are removed
                                first, so a deleted source leaves nothing behind.
  expect-test <bundle> [--root <dir>]
                                Evaluate the tests in a linked, canonicalized
                                bundle and record each result as a '# = …'
                                comment below the expression it belongs to.

Options:
  --root <dir>          Where the sources live. Defaults to src.
  --cache <dir>         Where to memoize compiled chunks. Compiling is a pure
                        function of the chunk and the compiler, so a rebuild only
                        pays for what actually changed. Defaults to .cache/lambada.
  --compiler <file>     The compiler to use, as a .dag. Defaults to the one
                        shipped in compiler/.
  --tree-calculus <path>
                        A tree-calculus checkout to use, instead of downloading
                        the published runtime. Also settable as
                        $LAMBADA_TREE_CALCULUS.

Between the two commands, link and canonicalize the modules with dag.js:

  lambada compile
  dag.js link $(find src -name '.*.dag' | sort) | dag.js canonicalize > bundle.dag
  lambada expect-test bundle.dag`;

function parse_args(argv) {
  const command = argv[0];
  const positional = [];
  const options = {};
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${arg} needs a value`);
      return argv[++i];
    };
    if (arg === '--root') options.root = value();
    else if (arg === '--cache') options.cache = value();
    else if (arg === '--compiler') options.compiler = value();
    else if (arg === '--tree-calculus') options.tree_calculus = value();
    else if (arg.startsWith('--')) throw new Error(`unrecognized option ${arg}`);
    else positional.push(arg);
  }
  return { command, positional, options };
}

function main(argv) {
  if (!argv.length || argv[0] === '-h' || argv[0] === '--help') {
    console.log(USAGE);
    return;
  }

  const { command, positional, options } = parse_args(argv);
  if (!['compile', 'expect-test'].includes(command)) {
    throw new Error(`unrecognized command ${command}`);
  }

  // Only now, so that a mistyped command does not go looking for a runtime.
  const runtime = load(options.tree_calculus);
  const root = options.root ?? 'src';

  switch (command) {
    case 'compile':
      require('./compile.js').compile({
        runtime,
        root,
        compiler: options.compiler ?? COMPILER,
        cache_dir: resolve(options.cache ?? '.cache/lambada'),
        cwd: process.cwd(),
      });
      break;

    case 'expect-test': {
      if (!positional.length) throw new Error('expect-test needs a bundle to evaluate');
      require('./expect-test.js').expect_test({ runtime, root, bundle_path: positional[0] });
      break;
    }
  }
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(`lambada: ${error.message}`);
  process.exit(1);
}
