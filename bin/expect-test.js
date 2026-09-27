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
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
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

// What a test produced, kept by the runtime beside its reductions and under
// the same address: the fingerprint of the test's term, which decides its
// result. The name carries the format; bump it when an entry's meaning changes.
const RESULT_STORE = 'expect-v1';

/**
 * Evaluate `tests` against `library`, `jobs` at a time, each thread holding a
 * reducer of its own and pulling the next test when it finishes one — tests
 * range from instant to minutes, so fixed shares would leave threads idle.
 *
 * One thread starts alone and reads the library first: with a reduction cache,
 * that leaves the evaluated library on disk, and the threads started once it
 * is there load that instead of evaluating it again each.
 */
function evaluate({ tree_calculus, library, bundle_path, jobs, tests }) {
  const results = new Array(tests.length);
  const queue = tests.map((test, index) => ({ index, ...test }));
  const threads = [];
  let running = 0;
  return new Promise((ok, fail) => {
    const failed = error => { threads.forEach(thread => thread.terminate()); fail(error); };
    const start = first => {
      running++;
      const thread = new Worker(__filename, {
        workerData: { expect_test: { tree_calculus, library, bundle_path } },
      });
      threads.push(thread);
      const feed = () => thread.postMessage(queue.shift() ?? null);
      thread.on('message', ({ index, answer, error }) => {
        if (error) return failed(new Error(error));
        if (index === undefined) {
          // The library is read; everyone else may start.
          if (first) for (let n = 1; n < Math.min(jobs, tests.length); n++) start(false);
        } else {
          results[index] = answer;
        }
        feed();
      });
      thread.on('error', failed);
      thread.on('exit', code => {
        if (code !== 0) return failed(new Error(`a test thread exited with ${code}`));
        if (--running === 0) ok(results);
      });
    };
    start(true);
  });
}

/** A worker thread's side of `evaluate`: the library once, then one test per message. */
function serve({ tree_calculus, library, bundle_path }) {
  const runtime = require('./runtime.js').load(tree_calculus);
  const { LEAF, environment, evaluator, marshal, to_file } = runtime;
  const get = environment(evaluator, library, { origin: bundle_path });
  const not_a_pair = () => { throw new Error('a test did not reduce to a pair of values'); };
  const halves = evaluator.triage(not_a_pair, not_a_pair, (raw, rendered) => [raw, rendered]);

  // Read the library before the first test rather than during it — asking for
  // anything at all is what pulls it into scope, and what it costs is its own
  // to report.
  process.stderr.write('  the library\n');
  get.reduce(`${LEAF}\n`);
  parentPort.postMessage({});

  parentPort.on('message', task => {
    // Explicitly: the reducer's process would otherwise keep the thread alive.
    if (!task) process.exit(0);
    const { index, text, where } = task;
    process.stderr.write(`  ${where}\n`);
    try {
      const [raw, rendered] = halves(get.reduce(text));
      const file = to_file(evaluator, raw);
      const answer = file
        // Unabbreviated and named, so `shasum -a 256 <file>` reproduces it.
        ? { result: `${file.name} sha256:${createHash('sha256').update(file.bytes).digest('hex')}`,
            file: { name: file.name, bytes: Buffer.from(file.bytes).toString('base64') } }
        : { result: marshal.to_string(rendered) };
      parentPort.postMessage({ index, answer });
    } catch (error) {
      parentPort.postMessage({ error: `${where}: ${error.message}` });
    }
  });
}

async function expect_test({ runtime, root, bundle_path, jobs = 1, tree_calculus }) {
  const { DagModule, cache_store, fingerprint } = runtime;

  const linked = DagModule.parse(readFileSync(bundle_path, 'utf8'));
  const { defining_line, by_source, compiled_from } = tests_by_source(runtime, root, linked);

  // Refuse before evaluating anything: a stale source is found in a moment,
  // and a run that would have to be thrown away should not take an hour first.
  const contents = new Map();
  for (const [source_path, recorded] of compiled_from) {
    const content = readFileSync(source_path, 'utf8');
    check_compiled_from(source_path, content, recorded);
    contents.set(source_path, content);
  }

  // Nothing in the bundle refers to a test, so every test is a root the library
  // is entirely separable from. Only the library goes into scope; each test is
  // read against it on its own.
  const { shared, exclusive } = linked.partition(
    [...by_source.values()].flatMap(({ tests }) => tests.map(({ symbol }) => symbol)));
  const library = shared.toString();
  const addresses = fingerprint(library).fingerprints;

  const tests = [];
  for (const [source_path, { tests: of_source }] of by_source) {
    const physical = physical_lines(contents.get(source_path));
    for (const { symbol, target, code_line } of of_source) {
      // The test node is `_to_string expr`; a file has to be recognized on the
      // raw expression, which is its right child.
      const definition = defining_line.get(target);
      const expression = definition && definition.length === 3
        ? definition[2].symbol
        : target.symbol;
      const text = test_dag(runtime, exclusive.get(symbol), expression, symbol);
      tests.push({
        source_path, code_line, text,
        where: `${source_path}:${physical[code_line]}`,
        key: fingerprint(text, name => addresses.get(name)).value,
      });
    }
  }

  // A test whose term was answered before costs nothing; a term asked about
  // twice is evaluated once.
  const store = cache_store(RESULT_STORE);
  const answers = new Map();
  const missing = new Map();
  for (const test of tests) {
    const address = test.key.toString('hex');
    const stored = store?.get(test.key);
    if (stored) answers.set(address, JSON.parse(stored));
    else missing.set(address, test);
  }
  process.stderr.write(`  ${missing.size} of ${tests.length} tests to evaluate\n`);
  if (missing.size) {
    const evaluated = await evaluate({
      tree_calculus, library, bundle_path, jobs: Math.max(1, jobs),
      tests: [...missing.values()].map(({ text, where }) => ({ text, where })),
    });
    [...missing.values()].forEach((test, i) => {
      answers.set(test.key.toString('hex'), evaluated[i]);
      store?.put(test.key, JSON.stringify(evaluated[i]));
    });
  }

  // Every source gets its blocks rewritten, one without tests included: its
  // last test may have been deleted, and its result with it.
  const stale = generated_files(root);
  const written_by = new Map();
  const blocks = new Map([...contents.keys()].map(path => [path, new Map()]));
  for (const { source_path, code_line, key } of tests) {
    const { result, file } = answers.get(key.toString('hex'));
    if (file) {
      const { file_directory } = by_source.get(source_path);
      const path = resolve(file_directory, file.name);
      if (written_by.has(path)) {
        throw new Error(`${path}: written by a test in ${written_by.get(path)} and one in ${source_path}`);
      }
      written_by.set(path, source_path);
      mkdirSync(file_directory, { recursive: true });
      writeFileSync(path, Buffer.from(file.bytes, 'base64'));
      stale.delete(path);
    }
    blocks.get(source_path).set(code_line, comment_block(result));
  }
  for (const [source_path, content] of contents) {
    write_results(source_path, content, blocks.get(source_path));
  }
  remove_stale(stale);
}

// Declared last, below everything it reaches: this file is its own worker
// entry, and a `const` above would still be in its dead zone on that thread.
if (!isMainThread && workerData && workerData.expect_test) serve(workerData.expect_test);

module.exports = { expect_test };
