#!/usr/bin/env node
'use strict';

// Tests for the conventions in project.js. Run with `node bin/test.js`.
//
// These are the rules that turn a path into a name and a name back into a
// path, so what they mostly assert is that the two directions agree — and that
// whatever extensions a project puts on a source file change none of it.

const assert = require('assert');
const { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } = require('fs');
const { tmpdir } = require('os');
const { join, resolve } = require('path');
const {
  is_lamb_file, lamb_base, lamb_source_path, sources,
  namespace, test_symbol, parse_test_symbol, chunks, fingerprint,
} = require('./project.js');

let failures = 0;
function check(what, fn) {
  try { fn(); console.log(`PASS ${what}`); }
  catch (error) { failures++; console.log(`FAIL ${what}: ${error.message}`); }
}

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

check('chunks and fingerprints count code lines, not prose', () => {
  const source = 'a = △\n\n# a comment\nb = a\n  c\n';
  assert.deepEqual(chunks(source).map(c => c.code_line), [1, 3]);
  assert.equal(fingerprint(source), fingerprint('a = △\nb = a\n  c\n'));
});

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
