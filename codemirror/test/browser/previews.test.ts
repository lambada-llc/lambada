import { describe, expect, it } from 'vitest';

import type { Preview, Tree } from '../../src/index';
import { compiled, mount, waitFor } from './mount';

const previewTexts = () =>
  [...document.querySelectorAll('.cm-preview')].map((p) => p.textContent);

const showing = async (count: number) =>
  waitFor(`${count} previews`, () => previewTexts().length === count);

describe('previews', () => {
  it('shows what an expression comes to, and nothing for a definition', async () => {
    const view = mount('id = \\x x\n\n△');
    await compiled(view);
    await showing(1);
    // The leaf evaluates to itself, which is the one value with a written form
    // short enough to state outright.
    expect(previewTexts()).toEqual(['= △']);
  });

  it('writes the value as a tree', async () => {
    const view = mount('△ △ △');
    await compiled(view);
    await showing(1);
    expect(previewTexts()[0]).toMatch(/^= △( |\(|$)/);
  });

  it('shows nothing when asked not to', async () => {
    const view = mount('△', { compile: { previewResults: false } });
    await compiled(view);
    await new Promise((resume) => setTimeout(resume, 800));
    expect(previewTexts()).toEqual([]);
  });

  it('is not part of the document', async () => {
    // It sits exactly where a click at the end of a line lands, and an event
    // inside a widget is one the editor drops — cursor and all.
    const view = mount('△');
    await compiled(view);
    await showing(1);
    const style = getComputedStyle(document.querySelector('.cm-preview')!);
    expect(style.userSelect).toBe('none');
    expect(style.pointerEvents).toBe('none');
  });

  it('shows what a host returns instead', async () => {
    const seen: Tree[] = [];
    const view = mount('△', {
      compile: {
        previewResults: (value: Tree): Preview => {
          seen.push(value);
          return { type: 'inline', formatted: 'whatever the host says' };
        },
      },
    });
    await compiled(view);
    await showing(1);
    expect(previewTexts()).toEqual(['= whatever the host says']);
    expect(seen).toEqual([[]]);
  });

  it('places an element a host builds, and keeps room for it', async () => {
    const element = document.createElement('div');
    element.id = 'from-the-host';
    const view = mount('△', {
      compile: { previewResults: (): Preview => ({ type: 'block', element, height_px: 64 }) },
    });
    await compiled(view);
    await waitFor('the block', () => !!document.querySelector('#from-the-host'));

    const wrap = document.querySelector('.cm-preview-block') as HTMLElement;
    expect(wrap.contains(element)).toBe(true);
    // A floor rather than a height: an element that grows once it has loaded
    // has to move the code below it rather than cover it.
    expect(getComputedStyle(wrap).minHeight).toBe('64px');
    expect(wrap.getBoundingClientRect().height).toBeGreaterThanOrEqual(64);
  });

  it('keeps a host element while what produces it is unchanged', async () => {
    // What a value is depends on everything above it, so an edit up there
    // rightly builds a new one. An edit below cannot change it, and rebuilding
    // then would throw away whatever state the host's element had.
    let built = 0;
    const view = mount('△\n\nid = \\x x', {
      compile: {
        previewResults: (): Preview => {
          built++;
          return { type: 'block', element: document.createElement('div'), height_px: 8 };
        },
      },
    });
    await compiled(view);
    await waitFor('the block', () => !!document.querySelector('.cm-preview-block'));
    const element = document.querySelector('.cm-preview-block')!.firstElementChild;

    view.dispatch({ changes: { from: view.state.doc.length, insert: '\n\nlater = \\y y' } });
    await compiled(view);
    await new Promise((resume) => setTimeout(resume, 500));
    expect(built).toBe(1);
    expect(document.querySelector('.cm-preview-block')!.firstElementChild).toBe(element);
  });
});
