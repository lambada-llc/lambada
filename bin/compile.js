'use strict';

// Compiling a project of LambAda sources into DAG modules.
//
// The compiler is itself a tree (compiler/compile_file.dag), applied to a whole
// source. What comes out is a DAG naming the source's definitions; namespacing
// it by where the source lives is what lets files refer to each other without
// imports.
//
// One `.<name>.dag` module is written next to each source. Linking them into a
// program is the tree calculus runtime's job, not ours.

const { readFileSync, writeFileSync, unlinkSync, readdirSync } = require('fs');
const { Worker, isMainThread, workerData } = require('worker_threads');
const { basename, dirname, relative, resolve } = require('path');
const { lamb_base, sources, code, physical_lines, namespace, test_symbol, source_symbol } = require('./project.js');


// The compiler names a bare expression's value after the code line its
// statement ends on, and records a statement it could not compile the same way.
const LINE = /^:line\.(\d+)$/;
const FAIL = /^:fail\.(\d+) /gm;

/**
 * Turn each bare top-level expression into a named test.
 *
 * The compiler names each one `:line.<n>`, after the code line it ends on;
 * naming it after its source as well makes the result addressable once
 * everything is linked, which is how the expect test finds its way back to the
 * expression it belongs to. The value line the file ends on goes: a module is
 * all definitions.
 *
 * The result is rendered through `_to_string` if the source defines one. If it
 * does not, identity stands in: `:i` is the identity the compiler emits for its
 * own use, and binding through it costs nothing.
 */
function name_tests(runtime, module, root, source_path) {
  const { box } = runtime;
  let to_string = null;
  const lines = [];

  for (const line of module.lines) {
    const test = LINE.exec(line[0].symbol);
    if (line.length === 2 && line[0].symbol === '_to_string') to_string = line[0];
    if (test && line.length === 2) {
      if (!to_string) {
        throw new Error(
          `${source_path}: cannot render test results, `
          + 'the compiler emitted no identity to fall back on');
      }
      lines.push([box(test_symbol(root, source_path, Number(test[1]))), to_string, line[1]]);
    } else if (!test) {
      lines.push(line);
      if (!to_string && line.length === 2 && line[0].symbol === ':i') {
        to_string = box('_to_string');
        lines.push([to_string, line[0], line[1]]);
      }
    }
  }

  module.lines = lines;
  return module;
}

/** Delete the modules a previous run wrote, so a deleted source leaves nothing behind. */
function clean(root) {
  (function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = resolve(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/^\..*\.dag$/.test(entry.name)) unlinkSync(full);
    }
  })(resolve(root));
}

/**
 * `source` compiled, refusing it if any statement did not compile.
 *
 * The compiler is given the code alone. It would skip the comments itself, but
 * only by reading them a character at a time, and a source can be megabytes of
 * recorded results; and it is the code a cached compile should be keyed on,
 * not the results the last build wrote below it.
 */
function compiled(compile_file, source, where) {
  const out = compile_file(code(source));
  const failed = [...out.matchAll(FAIL)].map(([, n]) => physical_lines(source)[Number(n)]);
  if (failed.length) {
    throw new Error(`${failed.map(line => `${where}:${line}`).join(', ')}: `
      + `the statement ending here does not compile`);
  }
  return out;
}

/** Compile one source into the `.<name>.dag` module beside it. */
function compile_source(runtime, compile_file, { root, cwd, prelude }, source_path) {
  const { DagModule, LEAF, box } = runtime;
  const relative_path = relative(cwd, source_path);
  const source = readFileSync(source_path, 'utf8');
  process.stderr.write(`  ${relative_path}\n`);

  // The prelude first: compiled code refers to the combinator labels and
  // leaves defining them to whoever assembles the module, which is this.
  const module = DagModule.parse(prelude + compiled(compile_file, source, relative_path),
    { absorb_internal_aliases: false });
  name_tests(runtime, module, root, source_path);
  module.qualify(namespace(root, source_path));

  // Which source this was, in the state it was in. The name is the whole
  // point, so what it names can be the leaf; it rides through linking and
  // canonicalization like any other symbol, and tells the expect test that
  // the lines it is about to write results under are still the lines the
  // tests were named after.
  module.lines.push([box(source_symbol(root, source_path, source)), box(LEAF)]);

  const name = lamb_base(basename(source_path));
  writeFileSync(resolve(dirname(source_path), `.${name}.dag`), module.toString());
}

/** Compile `paths`, one compiler for all of them. */
function compile_sources({ runtime, root, compiler, prelude: prelude_path, cache_dir, cwd, paths }) {
  const compile_file = runtime.transformer(runtime.evaluator, readFileSync(compiler, 'utf8'), {
    cache_dir,
  });
  const prelude = readFileSync(prelude_path, 'utf8');
  for (const source_path of paths) {
    compile_source(runtime, compile_file, { root, cwd, prelude }, source_path);
  }
}

/**
 * Deal `paths` into `jobs` shares of roughly equal work.
 *
 * Work is measured in characters rather than sources — one source is a hundred
 * times another — so the longest go first and each lands wherever the least is
 * waiting.
 */
function shares(paths, jobs) {
  const weighed = paths
    .map(path => ({ path, size: readFileSync(path, 'utf8').length }))
    .sort((a, b) => b.size - a.size);
  const out = Array.from({ length: jobs }, () => ({ paths: [], size: 0 }));
  for (const { path, size } of weighed) {
    const lightest = out.reduce((a, b) => (b.size < a.size ? b : a));
    lightest.paths.push(path);
    lightest.size += size;
  }
  return out.filter(share => share.paths.length).map(share => share.paths);
}

async function compile(options) {
  const { root, jobs = 1, tree_calculus } = options;
  clean(root);
  const paths = sources(resolve(root));

  if (jobs <= 1 || paths.length < 2) return compile_sources({ ...options, paths });

  // A source is a unit of work on its own — it compiles, and the module it
  // makes is written beside it — so sharding sources is all the parallelism
  // needs. Each worker holds its own compiler; what they memoize goes to the
  // one cache, so a later build compiles only the sources that changed.
  const { runtime, ...shared } = options;
  await Promise.all(shares(paths, jobs).map(share => new Promise((ok, fail) => {
    const worker = new Worker(__filename, {
      workerData: { compile: { ...shared, paths: share, tree_calculus } },
      stderr: false,
    });
    worker.on('error', fail);
    worker.on('exit', code => code === 0 ? ok() : fail(new Error(`compile worker exited with ${code}`)));
  })));
}

// Declared last, below everything it reaches: this file is its own worker
// entry, and a `const` above would still be in its dead zone on that thread.
if (!isMainThread && workerData && workerData.compile) {
  const { tree_calculus, ...rest } = workerData.compile;
  compile_sources({ runtime: require('./runtime.js').load(tree_calculus), ...rest });
}

/**
 * One source as the compiler emits it, after the prelude. Nothing is named or
 * qualified: it ends on its last bare expression's value, as the compiler names
 * it, which is what a snippet run against a library wants, and what a test of
 * the compiler's own output pins.
 */
function emit({ runtime, compiler, prelude, cache_dir, source, where = 'emit' }) {
  const compile_file = runtime.transformer(runtime.evaluator, readFileSync(compiler, 'utf8'), {
    cache_dir,
  });
  return readFileSync(prelude, 'utf8') + compiled(compile_file, source, where);
}

module.exports = { compile, emit };
