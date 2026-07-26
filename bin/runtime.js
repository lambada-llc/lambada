'use strict';

// Locating the tree calculus runtime.
//
// LambAda compiles to trees, so its build tool needs something that can evaluate
// them and work with DAGs. That is `bin/dag.js` from the tree-calculus repo,
// which has no dependencies of its own beyond Node.
//
// Point at a checkout with --tree-calculus or $LAMBADA_TREE_CALCULUS. Failing
// that we download the published one and keep it, the way compiler/compile.sh
// has always done.

const { execFileSync } = require('child_process');
const { existsSync, mkdirSync, renameSync } = require('fs');
const { resolve } = require('path');

const PUBLISHED = 'https://raw.githubusercontent.com/lambada-llc/tree-calculus/refs/heads/main/bin/dag.js';
const CACHE = resolve(__dirname, '.tree-calculus');

/** Resolve `hint` (a checkout, a bin directory, or dag.js itself) to dag.js. */
function locate(hint) {
  if (hint === undefined) return null;
  const candidates = hint.endsWith('.js')
    ? [hint]
    : [resolve(hint, 'bin/dag.js'), resolve(hint, 'dag.js')];
  const found = candidates.find(existsSync);
  if (!found) {
    throw new Error(`no dag.js under ${hint} (looked for ${candidates.join(' and ')})`);
  }
  return found;
}

function download() {
  const path = resolve(CACHE, 'dag.js');
  if (existsSync(path)) return path;
  mkdirSync(CACHE, { recursive: true });
  process.stderr.write('Downloading the tree calculus runtime...\n');
  const temporary = `${path}.part`;
  try {
    execFileSync('curl', ['--silent', '--fail', '--location', '-o', temporary, PUBLISHED]);
  } catch (error) {
    throw new Error(
      `could not download the tree calculus runtime from ${PUBLISHED}.\n`
      + 'Pass --tree-calculus <path to a tree-calculus checkout> instead.');
  }
  renameSync(temporary, path);
  return path;
}

/** The runtime's exports: DagModule, link, environment, transformer, to_file, ... */
function load(hint) {
  return require(locate(hint ?? process.env.LAMBADA_TREE_CALCULUS) ?? download());
}

module.exports = { load };
