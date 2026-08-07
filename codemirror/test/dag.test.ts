import { describe, expect, it } from 'vitest';

import { dagOf, type Tree } from '../src/tree';

/**
 * The format, read back: `a b c` binds `a` to `b` applied to `c`, `a b` binds
 * `a` to `b`, and a bare `a` ends the document naming its value.
 *
 * Written out here rather than shared with the writer, so that a mistake in
 * one is not a matching mistake in the other.
 */
function read(text: string): Tree {
  const bound = new Map<string, Tree>([['△', []]]);
  const get = (name: string): Tree => {
    const tree = bound.get(name);
    if (!tree) throw new Error(`unbound: ${name}`);
    return tree;
  };
  for (const line of text.split('\n')) {
    const [a, b, c] = line.split(' ');
    if (c) {
      const [left, right] = [get(b), get(c)];
      if (left.length === 0) bound.set(a, [right]);
      else if (left.length === 1) bound.set(a, [left[0], right]);
      else throw new Error(`applying a fork is not a value: ${line}`);
    } else if (b) bound.set(a, get(b));
    else if (a) return get(a);
  }
  throw new Error('not terminated by a value');
}

/** Structure alone, so two trees compare equal however they were shared. */
const shapeOf = (tree: Tree): string =>
  `(${(tree as readonly Tree[]).map(shapeOf).join('')})`;

const leaf: Tree = [];
const stem = (a: Tree): Tree => [a];
const fork = (a: Tree, b: Tree): Tree => [a, b];

describe('dagOf', () => {
  it('writes the leaf as the bare name that binds it', () => {
    expect(dagOf(leaf)).toBe('△');
  });

  it('writes a value the format reads back as the same value', () => {
    for (const tree of [
      leaf,
      stem(leaf),
      fork(leaf, leaf),
      fork(stem(leaf), fork(leaf, stem(stem(leaf)))),
    ])
      expect(shapeOf(read(dagOf(tree)))).toBe(shapeOf(tree));
  });

  it('names every application once, however often a subtree appears', () => {
    const shared = fork(stem(leaf), stem(leaf));
    // Two stems, built once and used twice, and two built separately: the
    // same value, so the same document.
    const one = stem(leaf);
    expect(dagOf(fork(one, one))).toBe(dagOf(shared));
    expect(dagOf(shared).split('\n')).toHaveLength(4);
  });

  it('collapses a subtree repeated many times', () => {
    // A list of the same element twenty times. Sharing is by application, so
    // the twenty elements cost nothing and only the spine grows.
    let list: Tree = leaf;
    for (let i = 0; i < 20; i++) list = fork(stem(stem(leaf)), list);
    expect(dagOf(list).split('\n').length).toBeLessThan(30);
  });

  it('writes a value deeper than the call stack goes', () => {
    let deep: Tree = leaf;
    for (let i = 0; i < 200_000; i++) deep = stem(deep);
    const text = dagOf(deep);
    expect(text.split('\n')).toHaveLength(200_001);
  });
});
