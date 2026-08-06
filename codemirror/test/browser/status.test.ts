import { describe, expect, it } from 'vitest';

import { lambadaCompilations } from '../../src/index';
import { compiled, lines, mount, statusOf } from './mount';

describe('status', () => {
  it('blocks the statements below one that would not compile', async () => {
    // Nothing can be said about them: a statement that did not compile may
    // have defined anything, and guessing turns one unfinished line into a
    // page of errors.
    const view = mount('id = \\x x\n\nid 1\n\ninvalid syntax :(\n\nid 2');
    await compiled(view);
    expect(lines().map(statusOf).filter(Boolean)).toEqual([
      'ok',
      'ok',
      'error',
      'blocked',
    ]);
  });

  it('does not block them for a name nothing defines', async () => {
    // That statement's own definitions are all there in what the compiler
    // produced, so they carry forward and the rest is judged on its own.
    const view = mount('id = \\x x\n\nnope 1\n\nid 2');
    await compiled(view);
    expect(lines().map(statusOf).filter(Boolean)).toEqual(['ok', 'error', 'ok']);
  });

  it('reserves the border on every line, including ones with no status', async () => {
    // A border only on the lines that have a status makes the text jump
    // sideways as each one lands. Every line pays for it, always.
    const view = mount('id = \\x x\n\nnope 1');
    await compiled(view);
    const widths = lines().map((line) => ({
      status: statusOf(line),
      width: getComputedStyle(line).borderLeftWidth,
    }));
    expect(widths.some((w) => w.status === null)).toBe(true);
    for (const { width } of widths) expect(parseFloat(width)).toBeGreaterThan(0);
    expect(new Set(widths.map((w) => w.width)).size).toBe(1);
  });

  it('marks nothing when there is nothing to compile with', async () => {
    const view = mount('id = \\x x\n\nnope 1', { compile: false });
    // Nothing to wait on, so give the workers that are not running a chance to
    // report anyway.
    await new Promise((resume) => setTimeout(resume, 500));
    expect(lines().map(statusOf).filter(Boolean)).toEqual([]);
    // Not merely unmarked: the field the marks read is not in the state at all.
    expect(view.state.field(lambadaCompilations, false)).toBe(undefined);
  });
});
