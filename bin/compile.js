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
const { basename, dirname, relative, resolve } = require('path');
const { sources, chunks, namespace, test_symbol } = require('./project.js');

// The compiler names the leaf `__ENV△` in its output, as a reference to the
// binding compile.sh puts in front of everything it emits. Nothing downstream
// needs to know that: the leaf has a spelling of its own.
const COMPILER_LEAF = '__ENV△';

function normalize_leaf(dag) {
  return dag.split('\n').flatMap(line => {
    const words = line.split(/\s+/).filter(Boolean);
    if (!words.length) return [line];
    if (words[0] === COMPILER_LEAF) return []; // the binding itself, now redundant
    return [words.map((word, i) => i > 0 && word === COMPILER_LEAF ? '△' : word).join(' ')];
  }).join('\n');
}

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

function compile({ runtime, root, compiler, cache_dir, cwd }) {
  const { DagModule, transformer } = runtime;
  const compile_chunk = transformer(runtime.evaluator, readFileSync(compiler, 'utf8'), {
    cache_dir,
  });

  clean(root);

  for (const source_path of sources(resolve(root))) {
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
        if (words.length === 1) test_lines.push(chunk.end_line);
      }
      dag += compiled.endsWith('\n') ? compiled : compiled + '\n';
    }
    process.stderr.write(`  ${relative_path} (${pieces.length} chunks)\n`);

    const module = DagModule.parse(normalize_leaf(dag), { absorb_internal_aliases: false });
    name_tests(runtime, module, root, source_path, test_lines);
    module.qualify(namespace(root, source_path));

    const name = basename(source_path, '.lamb');
    writeFileSync(resolve(dirname(source_path), `.${name}.dag`), module.toString());
  }
}

module.exports = { compile };
