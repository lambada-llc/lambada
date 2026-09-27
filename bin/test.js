#!/usr/bin/env node
'use strict';

// Tests for the build tool. Run with `node bin/test.js`.
//
// These are the rules that turn a path into a name and a name back into a
// path, so what they mostly assert is that the two directions agree — and that
// whatever extensions a project puts on a source file change none of it.

const assert = require('assert');
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync } = require('fs');
const { tmpdir } = require('os');
const { join, resolve } = require('path');
const {
  is_lamb_file, lamb_base, lamb_source_path, sources,
  namespace, test_symbol, parse_test_symbol, fingerprint,
} = require('./project.js');
const { compile, emit } = require('./compile.js');
const { expect_test } = require('./expect-test.js');
const { load } = require('./runtime.js');

// Run in the order written, one at a time, so an async check finishes before
// the next starts.
const checks = [];
function check(what, fn) { checks.push({ what, fn }); }

check('a source is recognized by name, not by kind', () => {
  assert.ok(is_lamb_file('bool.lamb'));
  assert.ok(is_lamb_file('bool.anything.lamb'));
  assert.ok(!is_lamb_file('bool.dag'));
  assert.ok(!is_lamb_file('lamb'));
});

check('extensions are not part of the name', () => {
  assert.equal(lamb_base('bool.lamb'), 'bool');
  assert.equal(lamb_base('bool.anything.lamb'), 'bool');
  assert.equal(lamb_base('bool.two.of.them.lamb'), 'bool');
});

check('however a file is marked, it names the same module and tests', () => {
  const root = '/p/src';
  for (const marked of ['/p/src/bool.x.lamb', '/p/src/bool.y.z.lamb']) {
    assert.equal(namespace(root, marked), namespace(root, '/p/src/bool.lamb'));
    assert.equal(test_symbol(root, marked, 14), test_symbol(root, '/p/src/bool.lamb', 14));
  }
});

check('a test symbol names its source, however that source is spelled', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lambada-test-'));
  try {
    mkdirSync(join(dir, 'src/nat'), { recursive: true });
    writeFileSync(join(dir, 'src/bool.lamb'), 'x = △\n');
    // A source need not be a regular file, which is why discovery cannot ask
    // isFile(): a Dirent for a symlink answers false.
    writeFileSync(join(dir, 'elsewhere.lamb'), 'y = △\n');
    symlinkSync('../../elsewhere.lamb', join(dir, 'src/nat/nat.marked.lamb'));

    const root = join(dir, 'src');
    assert.deepEqual(
      sources(root).sort(),
      [join(root, 'bool.lamb'), join(root, 'nat/nat.marked.lamb')].sort());

    for (const source of sources(root)) {
      const back = parse_test_symbol(root, test_symbol(root, source, 14));
      assert.equal(resolve(back.source_path), resolve(source));
      assert.equal(back.code_line, 14);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

check('an absent source falls back to the bare spelling', () => {
  assert.equal(lamb_source_path('/nowhere/bool'), '/nowhere/bool.lamb');
});

check('fingerprints count code lines, not prose', () => {
  assert.equal(fingerprint('a = △\n\n# a comment\nb = a\n  c\n'), fingerprint('a = △\nb = a\n  c\n'));
});

const compiler = resolve(__dirname, '../compiler/compile_file.dag');
const prelude = resolve(__dirname, '../compiler/prelude.dag');

check('emit is the prelude, then the file, ending on its value', () => {
  const out = emit({ runtime: load(), compiler, prelude, source: 'x = △\n\n# prose\nx\n' });
  const prelude_text = readFileSync(prelude, 'utf8');
  assert.ok(out.startsWith(prelude_text), 'the prelude comes first');
  assert.strictEqual(out.slice(prelude_text.length), 'x △\n:line.2 x\n:line.2\n',
    'then the file, its bare expression named after the code line it ends on');
});

check('a statement that does not compile is named by its line', () => {
  assert.throws(() => emit({ runtime: load(), compiler, prelude, source: 'x = △\n\n)\ny = x\n', where: 'f.lamb' }),
    /^Error: f\.lamb:3: the statement ending here does not compile$/);
});

check('a deleted test takes its result along, and a file written twice is refused', async () => {
  const runtime = load();
  const root = mkdtempSync(join(tmpdir(), 'lambada-test-'));
  const source = join(root, 'a.lamb');
  const run = async text => {
    writeFileSync(source, text);
    await compile({
      runtime, root, cwd: root,
      compiler, prelude,
    });
    const bundle = join(root, 'bundle.dag');
    const module = join(root, '.a.dag');
    writeFileSync(bundle, runtime.DagModule
      .parse(runtime.link([{ name: module, text: readFileSync(module, 'utf8') }]))
      .canonicalize().toString());
    await expect_test({ runtime, root, bundle_path: bundle });
    return readFileSync(source, 'utf8');
  };
  try {
    assert.strictEqual(await run('x = "hi"\nx\n'), 'x = "hi"\nx\n# = hi\n');
    assert.strictEqual(await run('x = "hi"\n# = hi\n'), 'x = "hi"\n');
    const file = bytes => `△ (△ "a.txt" "text/plain") "${bytes}"`;
    await assert.rejects(run(`${file(1)}\n${file(2)}\n`), /a\.txt: written by a test in .* and one in/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

(async () => {
  let failures = 0;
  for (const { what, fn } of checks) {
    try { await fn(); console.log(`PASS ${what}`); }
    catch (error) { failures++; console.log(`FAIL ${what}: ${error.message}`); }
  }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
