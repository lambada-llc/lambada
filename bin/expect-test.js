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
// The test signal is the diff, not an exit code: a result that changed shows up
// as a changed source file, to be reviewed and committed or fixed.
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
  EXPECT_DIR, is_source_line, is_test_symbol, parse_test_symbol, physical_lines,
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
function write_results(path, blocks) {
  const lines = readFileSync(path, 'utf8').split('\n');
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
function tests_by_source(runtime, root, bundle) {
  const { DagModule, is_label } = runtime;
  const defining_line = new Map();
  const by_source = new Map();

  for (const line of DagModule.parse(bundle).lines) {
    if (line.length === 2 || line.length === 3) defining_line.set(line[0], line);
    if (line.length !== 2 || !is_label(line[0].symbol) || !is_test_symbol(line[0].symbol)) continue;

    const { source_path, file_directory, code_line } = parse_test_symbol(root, line[0].symbol);
    if (!by_source.has(source_path)) by_source.set(source_path, { file_directory, tests: [] });
    by_source.get(source_path).tests.push({
      symbol: line[0].symbol,
      target: line[1],
      code_line,
    });
  }

  return { defining_line, by_source };
}

function expect_test({ runtime, root, bundle_path }) {
  const { environment, evaluator, marshal, to_file } = runtime;

  const bundle = readFileSync(bundle_path, 'utf8');
  const get = environment(evaluator, bundle, { origin: bundle_path });
  const { defining_line, by_source } = tests_by_source(runtime, root, bundle);

  const stale = generated_files(root);
  for (const [source_path, { file_directory, tests }] of by_source) {
    process.stderr.write(`  ${source_path}\n`);
    const blocks = new Map();
    const physical = physical_lines(readFileSync(source_path, 'utf8'));

    for (const { symbol, target, code_line } of tests) {
      // The test node is `_to_string expr`; a file has to be recognized on the
      // raw expression, which is its right child.
      const definition = defining_line.get(target);
      const expression = definition && definition.length === 3
        ? definition[2].symbol
        : target.symbol;

      let result;
      try {
        const file = to_file(evaluator, get(expression));
        if (file) {
          mkdirSync(file_directory, { recursive: true });
          const path = resolve(file_directory, file.name);
          writeFileSync(path, file.bytes);
          stale.delete(path);
          // Unabbreviated and named, so `shasum -a 256 <file>` reproduces it.
          const hash = createHash('sha256').update(file.bytes).digest('hex');
          result = `${file.name} sha256:${hash}`;
        } else {
          result = marshal.to_string(get(symbol));
        }
      } catch (error) {
        throw new Error(`${source_path}:${physical[code_line]}: ${error.message}`);
      }

      blocks.set(code_line, comment_block(result));
    }

    write_results(source_path, blocks);
  }
  remove_stale(stale);
}

module.exports = { expect_test };
