'use strict';

// Compiling a project of LambAda sources into DAG modules.
//
// The compiler is itself a tree (compiler/compile_to_dag.dag), applied to one
// top-level chunk at a time. What comes out is a DAG naming the chunk's
// definitions; namespacing it by where the source lives is what lets files refer
// to each other without imports.
//
// One `.<name>.dag` module is written next to each source. Linking them into a
// program is the tree calculus runtime's job, not ours.

const { readFileSync, writeFileSync, unlinkSync, readdirSync } = require('fs');
const { Worker, isMainThread, workerData } = require('worker_threads');
const { basename, dirname, relative, resolve } = require('path');
const { lamb_base, sources, chunks, namespace, test_symbol, source_symbol } = require('./project.js');

// The compiler refers to the leaf as `__ENV△` rather than `△`, and never
// defines it. That is deliberate: `△` is an ordinary name, so a source may bind
// it — `△ = lift △ id` is a perfectly good definition — and were the compiler
// to spell the leaf `△`, every leaf below such a binding would quietly become
// whatever the source bound.
//
// So the module says what the name means, on its own first line. Being first is
// the whole of it: there `△` is still the leaf, whatever a source binds it to
// further down, and every reference the compiler emitted resolves to that one
// definition. Nothing outside the module has to know the name, because the
// module no longer leaves it to anyone else to bind.
//
// Qualification makes it private without being told to — its local part opens
// with `_`, so it gets a `:N` of its own and no module offers it to another.
const COMPILER_LEAF = '__ENV△';

/**
 * Turn each bare top-level expression into a named test.
 *
 * A bare expression compiles to a one-word line — a value the module mentions
 * but does not bind. Naming it after the source line it ends on makes the result
 * addressable once everything is linked, which is how the expect test finds its
 * way back to the expression it belongs to.
 *
 * The result is rendered through `_to_string` if the source defines one. If it
 * does not, identity stands in: `:i` is the identity the compiler emits for its
 * own use, and binding through it costs nothing.
 */
function name_tests(runtime, module, root, source_path, test_lines) {
  const { box } = runtime;
  let to_string = null;
  let index = 0;
  const lines = [];

  for (const line of module.lines) {
    if (line.length === 2 && line[0].symbol === '_to_string') to_string = line[0];
    if (line.length === 1) {
      if (!to_string) {
        throw new Error(
          `${source_path}: cannot render test results, `
          + 'the compiler emitted no identity to fall back on');
      }
      lines.push([box(test_symbol(root, source_path, test_lines[index++])), to_string, line[0]]);
    } else {
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

/** Compile one source into the `.<name>.dag` module beside it. */
function compile_source(runtime, compile_chunk, { root, cwd }, source_path) {
  const { DagModule, LEAF, box } = runtime;
  const relative_path = relative(cwd, source_path);
  const source = readFileSync(source_path, 'utf8');

  let dag = '';
  const test_lines = [];
  const pieces = chunks(source);
  for (const chunk of pieces) {
    const compiled = compile_chunk(chunk.text);
    if (!compiled.trim()) throw new Error(`${relative_path}: compiler returned nothing for:\n${chunk.text}`);
    // A bare expression compiles to a trailing one-word line; a definition
    // does not, which is what tells the two apart.
    for (const line of compiled.split('\n')) {
      const words = line.trim().split(/\s+/).filter(Boolean);
      if (words.length === 1) test_lines.push(chunk.code_line);
    }
    dag += compiled.endsWith('\n') ? compiled : compiled + '\n';
  }
  process.stderr.write(`  ${relative_path} (${pieces.length} chunks)\n`);

  const module = DagModule.parse(
    `${COMPILER_LEAF} ${LEAF}\n${dag}`, { absorb_internal_aliases: false });
  name_tests(runtime, module, root, source_path, test_lines);
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
function compile_sources({ runtime, root, compiler, cache_dir, cwd, paths }) {
  const compile_chunk = runtime.transformer(runtime.evaluator, readFileSync(compiler, 'utf8'), {
    cache_dir,
  });
  for (const source_path of paths) {
    compile_source(runtime, compile_chunk, { root, cwd }, source_path);
  }
}

/**
 * Deal `paths` into `jobs` shares of roughly equal work.
 *
 * Work is chunks rather than sources — one source holds sixty and another two —
 * so the longest go first and each lands wherever the least is waiting.
 */
function shares(paths, jobs) {
  const weighed = paths
    .map(path => ({ path, chunks: chunks(readFileSync(path, 'utf8')).length }))
    .sort((a, b) => b.chunks - a.chunks);
  const out = Array.from({ length: jobs }, () => ({ paths: [], chunks: 0 }));
  for (const { path, chunks: n } of weighed) {
    const lightest = out.reduce((a, b) => (b.chunks < a.chunks ? b : a));
    lightest.paths.push(path);
    lightest.chunks += n;
  }
  return out.filter(share => share.paths.length).map(share => share.paths);
}

async function compile(options) {
  const { root, jobs = 1, tree_calculus } = options;
  clean(root);
  const paths = sources(resolve(root));

  if (jobs <= 1 || paths.length < 2) return compile_sources({ ...options, paths });

  // A source is a unit of work on its own — its chunks compile, and the module
  // they make is written beside it — so sharding sources is all the parallelism
  // needs. Each worker holds its own compiler; what they memoize goes to the
  // one cache, so a chunk two sources share is still compiled once across a
  // later build.
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

module.exports = { compile };
