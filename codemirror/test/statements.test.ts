import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';

import { lambadaStatements } from '../src/statements';

const statementsOf = (doc: string) =>
  EditorState.create({ doc, extensions: [lambadaStatements] }).field(lambadaStatements);

const textsOf = (doc: string) => statementsOf(doc).map((s) => s.text);

describe('statements', () => {
  it('starts one at every line that is not indented', () => {
    expect(textsOf('a\nb\nc')).toEqual(['a', 'b', 'c']);
  });

  it('continues one through the lines indented under it', () => {
    expect(textsOf('a\n  b\n  c\nd')).toEqual(['a\n  b\n  c', 'd']);
  });

  it('keeps the indentation of a continuation and drops it from the first line', () => {
    // What tells a continuation from the line it continues is the leading
    // space, so it is the one piece of whitespace that has to survive.
    expect(textsOf('  a\n  b')).toEqual(['a\n  b']);
  });

  it('separates statements on a blank line', () => {
    expect(textsOf('a\n\n  b')).toEqual(['a', 'b']);
  });

  it('continues through a line of only spaces without contributing one', () => {
    expect(textsOf('a\n \n  b')).toEqual(['a\n  b']);
  });

  it('does not continue through a tab', () => {
    expect(textsOf('a\n\tb')).toEqual(['a', 'b']);
  });

  it('drops trailing whitespace from every line', () => {
    expect(textsOf('a  \n  b  ')).toEqual(['a\n  b']);
  });

  it('ends a statement at its last line that is not blank', () => {
    const doc = 'ab\n  cd\n \n\nef';
    const [first] = statementsOf(doc);
    expect(doc.slice(first.from, first.to)).toBe('ab\n  cd');
  });

  it('finds nothing in a document of only blank lines', () => {
    expect(textsOf('\n  \n\t\n')).toEqual([]);
  });

  it('splits again when the document changes', () => {
    const state = EditorState.create({ doc: 'a\nb', extensions: [lambadaStatements] });
    const next = state.update({ changes: { from: 2, insert: ' ' } }).state;
    expect(next.field(lambadaStatements).map((s) => s.text)).toEqual(['a\n b']);
  });
});
