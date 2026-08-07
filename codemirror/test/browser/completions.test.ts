import { currentCompletions, startCompletion } from '@codemirror/autocomplete';
import type { EditorView } from '@codemirror/view';
import { describe, expect, it } from 'vitest';

import { compiled, mount, waitFor } from './mount';

async function offeredAtEnd(view: EditorView) {
  view.focus();
  view.dispatch({ selection: { anchor: view.state.doc.length } });
  startCompletion(view);
  await waitFor('completions', () => currentCompletions(view.state).length > 0);
  return currentCompletions(view.state).map((c) => c.label);
}

describe('completions', () => {
  it('offers what the statements above defined', async () => {
    const view = mount('first = \\x x\n\nsecond = \\y y\n\n');
    await compiled(view);
    const offered = await offeredAtEnd(view);
    expect(offered).toContain('first');
    expect(offered).toContain('second');
  });

  it('offers what the environment defined', async () => {
    const view = mount('', { compile: { environment: 't △' } });
    await waitFor('the field to exist', () => true);
    const offered = await offeredAtEnd(view);
    expect(offered).toContain('t');
  });

  it('does not offer names only the compiler uses', async () => {
    // Every compilation references the compiler's own name for the leaf, so it
    // is in scope everywhere — but nobody writes it, and a list that leads
    // with it is a list nobody asked for.
    const view = mount('first = \\x x\n\n');
    await compiled(view);
    const offered = await offeredAtEnd(view);
    expect(offered).toContain('first');
    expect(offered).not.toContain('__ENV△');
    // Nor the intermediate names a compilation invents on the way, which are
    // not identifiers at all.
    expect(offered.every((label) => !/^\d/.test(label))).toBe(true);
  });

  it('does not offer a name before the statement that defines it', async () => {
    const view = mount('\n\nlater = \\x x');
    await compiled(view);
    view.focus();
    view.dispatch({ selection: { anchor: 0 } });
    startCompletion(view);
    await new Promise((resume) => setTimeout(resume, 300));
    expect(currentCompletions(view.state).map((c) => c.label)).not.toContain('later');
  });
});
