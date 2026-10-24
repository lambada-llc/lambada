'use strict';

// A project built in one go: compiled, linked against its libraries,
// canonicalized and tested.
//
// A library is another directory of sources, compiled under its own root so
// its names are its own (`Bool.not`), and linked in without its tests, which
// are its own business: filed under this project's root, they would land in
// sources that are not there.

const { readFileSync, writeFileSync } = require('fs');
const { resolve } = require('path');
const { compile } = require('./compile.js');
const { expect_test } = require('./expect-test.js');
const { module_path, sources } = require('./project.js');

const NOT_LIBRARY = /^:(test|source)\./;

/** The modules compiled from `root`, as `link` takes them. */
const modules = root => sources(resolve(root)).map(source => {
  const name = module_path(source);
  return { name, text: readFileSync(name, 'utf8') };
});

/**
 * Writes `<root>/.dag-bundle-linked`, what a symbol is cut from to depend only
 * on what it is built from, and `<root>/.dag-bundle-canonical`, what the tests
 * read and what a symbol is run from.
 */
async function build({ runtime, root, libraries = [], out, jobs, ...options }) {
  const { DagModule, is_symbol_name, link } = runtime;

  const linked_libraries = [];
  for (const library of libraries) {
    process.stderr.write(`Compiling ${library}\n`);
    await compile({ ...options, runtime, root: library, jobs });
    const linked = DagModule.parse(link(modules(library)));
    const keep = [...new Set(linked.lines
      .filter(line => line.length > 1 && is_symbol_name(line[0].symbol) && !NOT_LIBRARY.test(line[0].symbol))
      .map(line => line[0].symbol))];
    linked_libraries.push({ name: library, text: linked.extract(keep).toString() });
  }

  process.stderr.write(`Compiling ${root}\n`);
  await compile({ ...options, runtime, root, jobs });
  const linked = link([...linked_libraries, ...modules(root)]);
  const bundle = resolve(root, '.dag-bundle-canonical');
  writeFileSync(resolve(root, '.dag-bundle-linked'), linked);
  writeFileSync(bundle, DagModule.parse(linked).canonicalize().toString());

  process.stderr.write('Running tests\n');
  await expect_test({ runtime, root, out, bundle_path: bundle, jobs, tree_calculus: options.tree_calculus });
}

module.exports = { build };
