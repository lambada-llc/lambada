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

const { createHash } = require('crypto');
const { readdirSync } = require('fs');
const { relative, resolve } = require('path');

/** Where a test's generated files go, as a sibling of the source that made them. */
const EXPECT_DIR = 'expect-test-out';

const TEST_SYMBOL = /^:test\.((?:[^.]+\.)+)(\d+)$/;
const SOURCE_SYMBOL = /^:source\.((?:[^.]+\.)+)([0-9a-f]{64})$/;

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

/** The lines a source is made of, as opposed to the blanks and comments between them. */
const is_source_line = line => line !== '' && !line.startsWith('#');

/**
 * Split a source into the units the compiler is applied to.
 *
 * A top-level line starts at column 0 and indented lines continue it; comments
 * and blank lines are dropped. `code_line` is the 1-based *code* line the chunk
 * ends on, which is where an expect test records its result. Counting code
 * lines rather than physical ones is what keeps a test's name fixed as the
 * build writes its own `# = …` comments into the file — and as the prose around
 * them changes.
 *
 * Chunking matters beyond tidiness: the compiler is a pure function, so
 * compiling a chunk at a time means an edit only costs what it actually changed.
 */
function chunks(content) {
  const found = [];
  let current = null;
  let code_line = 0;
  for (const line of content.split('\n')) {
    if (!is_source_line(line)) continue;
    code_line++;
    if (/^[ \t]/.test(line) && current) {
      current.text += '\n' + line;
      current.code_line = code_line;
    } else {
      current = { text: line, code_line };
      found.push(current);
    }
  }
  return found;
}

/** Physical line number of each code line, indexed 1-based by code line. */
function physical_lines(content) {
  const physical = [0];
  content.split('\n').forEach((line, i) => { if (is_source_line(line)) physical.push(i + 1); });
  return physical;
}

/**
 * What compiling a source depended on, and nothing else: its code lines.
 *
 * The build writes its own comments back into the file, so a fingerprint over
 * the whole text would go stale the moment a result is recorded. Comments and
 * blank lines are exactly what the compiler never saw — and what the code line
 * numbering already skips — so leaving them out identifies the source as the
 * compiler knew it, however the prose around it moves.
 */
function fingerprint(content) {
  return createHash('sha256').update(content.split('\n').filter(is_source_line).join('\n')).digest('hex');
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
 * The name of the test that a bare top-level expression on `code_line` becomes.
 *
 * The name encodes everything needed to record the result later — which file,
 * which line — so nothing else has to be written down and kept in sync.
 */
function test_symbol(root, source_path, code_line) {
  return `:test.${namespace_parts(root, source_path).join('')}${code_line}`;
}

/** Where the namespace segments of a `:test.…` or `:source.…` symbol came from. */
function source_of(root, prefix) {
  const segments = prefix.split('.').filter(Boolean).map(lower_initial);
  return {
    source_path: `${root}/${segments.join('/')}.lamb`,
    file_directory: [root, ...segments.slice(0, -1), EXPECT_DIR].join('/'),
  };
}

/** Read a test symbol back: which source made it, and where the result goes. */
function parse_test_symbol(root, symbol) {
  const match = symbol.match(TEST_SYMBOL);
  if (!match) throw new Error(`not a test symbol: ${symbol}`);
  return { ...source_of(root, match[1]), code_line: Number(match[2]) };
}

const is_test_symbol = symbol => TEST_SYMBOL.test(symbol);

/**
 * The name recording which source a module was compiled from, and in what state.
 *
 * Results are written back by code line, so a bundle whose modules no longer
 * match the sources would file every one of them under a line that has moved.
 * The fingerprint travels in a symbol name for the same reason a test's line
 * does: the name is the record, so there is nothing else to keep in sync.
 */
function source_symbol(root, source_path, content) {
  return `:source.${namespace_parts(root, source_path).join('')}${fingerprint(content)}`;
}

/** Read a source symbol back: which source it names, and what it looked like. */
function parse_source_symbol(root, symbol) {
  const match = symbol.match(SOURCE_SYMBOL);
  if (!match) throw new Error(`not a source symbol: ${symbol}`);
  const { source_path } = source_of(root, match[1]);
  return { source_path, fingerprint: match[2] };
}

const is_source_symbol = symbol => SOURCE_SYMBOL.test(symbol);

module.exports = {
  EXPECT_DIR,
  sources,
  chunks,
  is_source_line,
  physical_lines,
  fingerprint,
  namespace,
  test_symbol,
  parse_test_symbol,
  is_test_symbol,
  source_symbol,
  parse_source_symbol,
  is_source_symbol,
};
