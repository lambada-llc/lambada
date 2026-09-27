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
const PRELUDE = resolve(__dirname, '../compiler/prelude.dag');

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
  emit [file]                   One source as the compiler emits it — the
                                prelude, then each chunk — on standard output,
                                nothing named or qualified. Reads stdin without
                                a file. For a snippet to run against a library,
                                or to see what the compiler makes of a file.

Options:
  --root <dir>          Where the sources live. Defaults to src.
  --cache <dir>         Where to memoize compiled chunks. Compiling is a pure
                        function of the chunk and the compiler, so a rebuild only
                        pays for what actually changed. Defaults to .cache/lambada.
  --jobs <n>            Compile this many sources, or evaluate this many tests,
                        at once, each in a thread with a reducer of its own.
                        Defaults to 1: memory scales with the count, and a
                        reducer on a heavy source or test is not small.
  --compiler <file>     The compiler to use, as a .dag. Defaults to the one
                        shipped in compiler/.
  --prelude <file>      The combinator definitions a compiled chunk refers to,
                        as .dag lines, put at the top of each module. Belongs to
                        the compiler that emits those references; defaults to the
                        one shipped beside it.
  --tree-calculus <path>
                        A tree-calculus checkout to use, instead of downloading
                        the published runtime. Also settable as
                        $LAMBADA_TREE_CALCULUS.

Between compile and expect-test, link and canonicalize the modules with dag.js:

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
  if (!['compile', 'expect-test', 'emit'].includes(command)) {
    throw new Error(`unrecognized command ${command}`);
  }

  // Only now, so that a mistyped command does not go looking for a runtime.
  const runtime = load(options.tree_calculus);
  const root = options.root ?? 'src';

  switch (command) {
    case 'compile':
      await require('./compile.js').compile({
        runtime,
        root,
        compiler: options.compiler ?? COMPILER,
        prelude: options.prelude ?? PRELUDE,
        cache_dir: resolve(options.cache ?? '.cache/lambada'),
        cwd: process.cwd(),
        jobs: options.jobs ?? 1,
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
        cache_dir: resolve(options.cache ?? '.cache/lambada'),
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
        bundle_path: positional[0],
        jobs: options.jobs ?? 1,
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
