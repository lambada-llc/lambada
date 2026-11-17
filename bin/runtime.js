'use strict';

// Locating the tree calculus runtime.
//
// LambAda compiles to trees, so its build tool needs something that can evaluate
// them and work with DAGs. That is `bin/dag.js` from the tree-calculus repo,
// which has no dependencies of its own beyond Node.
//
// Point at a checkout with --tree-calculus or $LAMBADA_TREE_CALCULUS. Failing
// that we download the runtime at REVISION and keep it, so every run without a
// checkout uses the same one, and moving to a newer runtime is a change to
// REVISION, tested like any other.

const { execFileSync } = require('child_process');
const { existsSync, mkdirSync, renameSync } = require('fs');
const { dirname, resolve } = require('path');

const REVISION = 'dc0209ea817ccb5b15f565b294e4394d7b43edc4';
const CACHE = resolve(__dirname, '.tree-calculus', REVISION);

/** `file` of the runtime's bin/ in `hint`: a checkout, a bin directory, or a file beside it. */
function locate(hint, file) {
  const candidates = hint.endsWith('.js')
    ? [resolve(dirname(hint), file)]
    : [resolve(hint, 'bin', file), resolve(hint, file)];
  const found = candidates.find(existsSync);
  if (!found) {
    throw new Error(`no ${file} under ${hint} (looked for ${candidates.join(' and ')})`);
  }
  return found;
}

function download(file) {
  const target = resolve(CACHE, file);
  if (existsSync(target)) return target;
  mkdirSync(CACHE, { recursive: true });
  const url = `https://raw.githubusercontent.com/lambada-llc/tree-calculus/${REVISION}/bin/${file}`;
  process.stderr.write(`Downloading the tree calculus runtime's ${file}...\n`);
  const temporary = `${target}.part`;
  try {
    execFileSync('curl', ['--silent', '--fail', '--location', '-o', temporary, url]);
  } catch (error) {
    throw new Error(
      `could not download the tree calculus runtime from ${url}.\n`
      + 'Pass --tree-calculus <path to a tree-calculus checkout> instead.');
  }
  renameSync(temporary, target);
  return target;
}

/** The path of the runtime's `file` (dag.js, main.js, ...): from `hint`, $LAMBADA_TREE_CALCULUS, or downloaded. */
function path(file, hint = process.env.LAMBADA_TREE_CALCULUS) {
  return hint === undefined ? download(file) : locate(hint, file);
}

/** The runtime's exports: DagModule, link, environment, transformer, to_file, ... */
const load = hint => require(path('dag.js', hint));

// `node runtime.js main.js` prints where that file is, for compiler/compile.sh.
if (require.main === module) console.log(path(process.argv[2]));

module.exports = { load };
