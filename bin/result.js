'use strict';

// How a value is shown: by expect-test in the comment below its expression, and
// by the repl on its output, so that both say the same thing.

const { createHash } = require('crypto');

/**
 * Definition lines making `:pair<suffix>` the fork of two values: the value
 * itself, which a file is recognized on, and the value shown, which is what is
 * read otherwise.
 *
 * One fork rather than two reductions, because the first value is inside the
 * second — asked for separately they would be computed twice, and neither half
 * is forced before something reads it.
 */
function fork({ box, LEAF }, value, shown, suffix = '') {
  const [stem, pair] = [box(`:stem${suffix}`), box(`:pair${suffix}`)];
  return { pair, lines: [[stem, box(LEAF), value], [pair, stem, shown]] };
}

/** A reduced fork, taken apart: `[value, shown]`. */
function halves({ evaluator }) {
  const not_a_pair = () => { throw new Error('did not reduce to a pair of values'); };
  return evaluator.triage(not_a_pair, not_a_pair, (value, shown) => [value, shown]);
}

/**
 * What a file is shown as: everything it is, on one line — the hash
 * unabbreviated, so `shasum -a 256 <file>` reproduces it.
 */
function describe_file({ name, media_type, bytes }) {
  const hash = createHash('sha256').update(bytes).digest('hex');
  return `${name} ${media_type} ${bytes.length} bytes sha256:${hash}`;
}

module.exports = { fork, halves, describe_file };
