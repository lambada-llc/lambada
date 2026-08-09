'use strict';

// Expect tests.
//
// Every bare top-level expression in a `.lamb` file is a test. Compiling named
// each one after the code line it ends on, so evaluating the linked program and
// writing each result back as a `# = …` comment below its expression needs no
// bookkeeping beyond the symbol names themselves. The count skips comments and
// blank lines, so the result comments written here rename nothing and a rerun
// costs nothing.
//
// That bookkeeping holds only as long as the source still has the lines it was
// compiled from, so compiling records a fingerprint of each source's code lines
// in a `:source.…` symbol and this checks it before writing anything. A source
// edited since — or never recompiled — is refused rather than scattered with
// comments in the wrong places.
//
// The test signal is the diff, not an exit code: a result that changed shows up
// as a changed source file, to be reviewed and committed or fixed.
//
// The bundle is read in two parts: the library, and each test as a DAG of its
// own evaluated against it. Compiled, a test is a binding like any other, and
// an evaluator that normalizes what it reads — which is what a repository
// holding itself to eager termination asks for — would run every test in the
// library before the first result could be written. Split, a test costs what it
// costs, where it is reported, and one that fails to finish is named.
//
// An expression that evaluates to a file — △ (△ <name> <media type>) <bytes> —
// is written into a sibling expect-test-out/ directory instead, and the comment
// records its name and content hash.

const { createHash } = require('crypto');
const {
  mkdirSync, readdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync,
} = require('fs');
const { dirname, resolve } = require('path');
const {
  EXPECT_DIR, fingerprint, is_source_line, is_source_symbol, is_test_symbol,
  parse_source_symbol, parse_test_symbol, physical_lines,
} = require('./project.js');

// Only these lines are ours to rewrite; anything else in the source is the
// author's and is left alone.
const RESULT_HEAD = '# = ';
const RESULT_TAIL = '#   ';

function comment_block(result) {
  const [first, ...rest] = result.replace(/\n+$/, '').split('\n');
  return [RESULT_HEAD + first, ...rest.map(line => RESULT_TAIL + line)];
}

/**
 * Replace the machine-owned comment block below each tested line of `path`.
 *
 * Blocks are keyed by the code lines the test symbols were named after, so this
 * counts code lines as it walks — the blocks it rewrites along the way are
 * comments, and so do not shift the count.
 */
function write_results(path, content, blocks) {
  const lines = content.split('\n');
  const out = [];
  let code_line = 0;
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    out.push(line);
    if (is_source_line(line)) code_line++;
    // A `# = …` block anywhere is ours, so drop it wherever it turns up; only a
    // code line can claim a replacement.
    if (++i < lines.length && lines[i].startsWith(RESULT_HEAD)) {
      while (++i < lines.length && lines[i].startsWith(RESULT_TAIL));
    }
    const block = is_source_line(line) && blocks.get(code_line);
    if (block) out.push(...block);
  }
  writeFileSync(path, out.join('\n'));
}

/** Everything currently under an expect-test-out/ directory, to be pruned if unclaimed. */
function generated_files(root) {
  const files = new Set();
  (function walk(directory, generated) {
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = resolve(directory, entry.name);
      if (entry.isDirectory()) walk(full, generated || entry.name === EXPECT_DIR);
      else if (generated) files.add(full);
    }
  })(resolve(root), false);
  return files;
}

function remove_stale(stale) {
  const directories = new Set();
  for (const file of stale) {
    unlinkSync(file);
    directories.add(dirname(file));
  }
  for (const directory of [...directories].sort((a, b) => b.length - a.length)) {
    if (readdirSync(directory).length === 0) rmdirSync(directory);
  }
}

/** Group the bundle's test symbols by the source they came from. */
function tests_by_source(runtime, root, linked) {
  const { is_label } = runtime;
  const defining_line = new Map();
  const by_source = new Map();
  const compiled_from = new Map();

  for (const line of linked.lines) {
    if (line.length === 2 || line.length === 3) defining_line.set(line[0], line);
    if (line.length !== 2 || !is_label(line[0].symbol)) continue;

    if (is_source_symbol(line[0].symbol)) {
      const { source_path, fingerprint } = parse_source_symbol(root, line[0].symbol);
      compiled_from.set(source_path, fingerprint);
    }
    if (!is_test_symbol(line[0].symbol)) continue;

    const { source_path, file_directory, code_line } = parse_test_symbol(root, line[0].symbol);
    if (!by_source.has(source_path)) by_source.set(source_path, { file_directory, tests: [] });
    by_source.get(source_path).tests.push({
      symbol: line[0].symbol,
      target: line[1],
      code_line,
    });
  }

  return { defining_line, by_source, compiled_from };
}

/**
 * Refuse to write into a source the bundle was not compiled from.
 *
 * Results are filed by code line, so a source that has moved on since — edited
 * while the build ran, or never recompiled — would take every one of its
 * comments somewhere else, quietly and all at once. Compiling recorded what it
 * saw; if that no longer matches, the bundle is stale and the only fix is to
 * compile again.
 */
function check_compiled_from(source_path, content, recorded) {
  if (recorded === fingerprint(content)) return;
  throw new Error(recorded === undefined
    ? `${source_path}: the bundle records no source fingerprint, so its tests `
      + 'cannot be placed; compile again with a current lambada'
    : `${source_path}: changed since it was compiled, so its results would land `
      + 'on the wrong lines; compile and link again');
}

/**
 * One test as a DAG to be read against the library, ending in a fork of the two
 * values it yields: the expression itself, which is what a file has to be
 * recognized on, and the expression through `_to_string`, which is what the
 * result comment says.
 *
 * One fork rather than two reductions, because the first value is inside the
 * second — asked for separately they would be computed twice, and neither half
 * is forced before something reads it.
 */
function test_dag({ box, LEAF }, own, expression, symbol) {
  const [stem, pair] = [box(':stem'), box(':pair')];
  own.lines.push([stem, box(LEAF), box(expression)], [pair, stem, box(symbol)]);
  return own.toString([pair.symbol]);
}

function expect_test({ runtime, root, bundle_path }) {
  const { DagModule, LEAF, environment, evaluator, marshal, to_file } = runtime;

  const bundle = readFileSync(bundle_path, 'utf8');
  const linked = DagModule.parse(bundle);
  const { defining_line, by_source, compiled_from } = tests_by_source(runtime, root, linked);

  // Nothing in the bundle refers to a test, so every test is a root the library
  // is entirely separable from. Only the library goes into scope; the tests are
  // read one at a time against it, below.
  const { shared, exclusive } = linked.partition(
    [...by_source.values()].flatMap(({ tests }) => tests.map(({ symbol }) => symbol)));
  const get = environment(evaluator, shared.toString(), { origin: bundle_path });
  const not_a_pair = () => { throw new Error('a test did not reduce to a pair of values'); };
  const halves = evaluator.triage(not_a_pair, not_a_pair, (raw, rendered) => [raw, rendered]);

  // Read the library before the first test rather than during it — asking for
  // anything at all is what pulls it into scope, and what it costs is its own
  // to report. Splitting the bundle is what makes that cost separable; saying
  // whose it is is what makes the split visible.
  process.stderr.write('  the library\n');
  get.reduce(`${LEAF}\n`);

  const stale = generated_files(root);
  for (const [source_path, { file_directory, tests }] of by_source) {
    process.stderr.write(`  ${source_path}\n`);
    const content = readFileSync(source_path, 'utf8');
    check_compiled_from(source_path, content, compiled_from.get(source_path));
    const blocks = new Map();
    const physical = physical_lines(content);

    for (const { symbol, target, code_line } of tests) {
      // The test node is `_to_string expr`; a file has to be recognized on the
      // raw expression, which is its right child.
      const definition = defining_line.get(target);
      const expression = definition && definition.length === 3
        ? definition[2].symbol
        : target.symbol;

      let result;
      try {
        const [raw, rendered] = halves(
          get.reduce(test_dag(runtime, exclusive.get(symbol), expression, symbol)));
        const file = to_file(evaluator, raw);
        if (file) {
          mkdirSync(file_directory, { recursive: true });
          const path = resolve(file_directory, file.name);
          writeFileSync(path, file.bytes);
          stale.delete(path);
          // Unabbreviated and named, so `shasum -a 256 <file>` reproduces it.
          const hash = createHash('sha256').update(file.bytes).digest('hex');
          result = `${file.name} sha256:${hash}`;
        } else {
          result = marshal.to_string(rendered);
        }
      } catch (error) {
        throw new Error(`${source_path}:${physical[code_line]}: ${error.message}`);
      }

      blocks.set(code_line, comment_block(result));
    }

    write_results(source_path, content, blocks);
  }
  remove_stale(stale);
}

module.exports = { expect_test };
