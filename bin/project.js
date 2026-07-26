'use strict';

// Conventions for a directory of LambAda sources.
//
// A LambAda *project* is a directory tree of `.lamb` files with no import
// statements: symbols are namespaced by where they live, and what a file needs
// from elsewhere is simply what it mentions and does not define. `src/bool/bool.lamb`
// defining `not` therefore exports `Bool.not`, which any other file can use.
//
// This file holds everything that follows from that arrangement — how a source
// splits into compilable pieces, and how a path turns into a namespace and back.

const { readdirSync } = require('fs');
const { relative, resolve } = require('path');

/** Where a test's generated files go, as a sibling of the source that made them. */
const EXPECT_DIR = 'expect-test-out';

const TEST_SYMBOL = /^:test\.((?:[^.]+\.)+)(\d+)$/;

/** Every `.lamb` file under `dir`, in a stable order. */
function sources(dir) {
  const found = [];
  (function walk(current) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = resolve(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.lamb')) found.push(full);
    }
  })(dir);
  return found.sort();
}

/**
 * Split a source into the units the compiler is applied to.
 *
 * A top-level line starts at column 0 and indented lines continue it; comments
 * and blank lines are dropped. `end_line` is the 1-based source line the chunk
 * ends on, which is where an expect test records its result.
 *
 * Chunking matters beyond tidiness: the compiler is a pure function, so
 * compiling a chunk at a time means an edit only costs what it actually changed.
 */
function chunks(content) {
  const found = [];
  let current = null;
  content.split('\n').forEach((line, i) => {
    if (line === '' || line.startsWith('#')) return;
    if (/^[ \t]/.test(line) && current) {
      current.text += '\n' + line;
      current.end_line = i + 1;
    } else {
      current = { text: line, end_line: i + 1 };
      found.push(current);
    }
  });
  return found;
}

const sanitize = part => part.replace(/[^a-zA-Z0-9.]/g, '_');
const capitalize = part => part.charAt(0).toUpperCase() + part.slice(1);
const lower_initial = part => part.charAt(0).toLowerCase() + part.slice(1);

/**
 * The namespace segments a source's path implies, e.g. `bool/bool.lamb` under
 * root `src` gives `['Bool.', 'Bool.']` — one for the directory, one for the file.
 */
function namespace_parts(root, source_path) {
  return relative(resolve(root), resolve(source_path))
    .replace(/\.lamb$/, '')
    .split('/')
    .map(part => capitalize(sanitize(part)) + '.');
}

/** What a source's exports are prefixed with. Files at the root export unqualified. */
function namespace(root, source_path) {
  return namespace_parts(root, source_path).slice(0, -1).join('');
}

/**
 * The name of the test that a bare top-level expression on `end_line` becomes.
 *
 * The name encodes everything needed to record the result later — which file,
 * which line — so nothing else has to be written down and kept in sync.
 */
function test_symbol(root, source_path, end_line) {
  return `:test.${namespace_parts(root, source_path).join('')}${end_line}`;
}

/** Read a test symbol back: which source made it, and where the result goes. */
function parse_test_symbol(root, symbol) {
  const match = symbol.match(TEST_SYMBOL);
  if (!match) throw new Error(`not a test symbol: ${symbol}`);
  const segments = match[1].split('.').filter(Boolean).map(lower_initial);
  const directory = segments.slice(0, -1);
  return {
    source_path: `${root}/${segments.join('/')}.lamb`,
    file_directory: [root, ...directory, EXPECT_DIR].join('/'),
    line: Number(match[2]),
  };
}

const is_test_symbol = symbol => TEST_SYMBOL.test(symbol);

module.exports = {
  EXPECT_DIR,
  sources,
  chunks,
  namespace,
  test_symbol,
  parse_test_symbol,
  is_test_symbol,
};
