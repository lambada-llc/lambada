import { forEachDiagnostic, openLintPanel } from '@codemirror/lint';
import { basicDark } from 'cm6-theme-basic-dark';
import { basicLight } from 'cm6-theme-basic-light';
import { describe, expect, it } from 'vitest';

import { compiled, mount, waitFor } from './mount';

const reported = (view: Parameters<typeof compiled>[0]) => {
  const found: { text: string; message: string }[] = [];
  forEachDiagnostic(view.state, (diagnostic, from, to) =>
    found.push({
      text: view.state.doc.sliceString(from, to),
      message: diagnostic.message,
    }),
  );
  return found;
};

const linted = async (doc: string) => {
  const view = mount(doc);
  await compiled(view);
  await waitFor('the linter to run', () => reported(view).length > 0);
  return { view, found: reported(view) };
};

describe('diagnostics', () => {
  it('reports a name nothing defines, under the word itself', async () => {
    const { found } = await linted('nope 1');
    expect(found).toEqual([{ text: 'nope', message: 'nope is not defined' }]);
  });

  it('marks the whole statement for a name that was never written', async () => {
    // A record literal is desugared into a call the compiler makes up, so
    // there is no word in the document to put the squiggle under. Falling back
    // to the statement beats marking nothing at all.
    const { found } = await linted('{ "kind": 1 }');
    expect(found).toHaveLength(1);
    expect(found[0].text).toBe('{ "kind": 1 }');
    expect(found[0].message).toMatch(/is not defined/);
  });

  it('says nothing about a document where every name resolves', async () => {
    const view = mount('id = \\x x\n\nid 1');
    await compiled(view);
    // Long enough for the linter's own delay to have passed.
    await new Promise((resume) => setTimeout(resume, 1200));
    expect(reported(view)).toEqual([]);
  });

  // Under the themes that broke it. A theme picks the tooltip background from
  // its own palette, and both of these pick the end that matches their own
  // text, so without the colours stated on the diagnostic the message comes
  // out dark on dark or light on light.
  for (const [name, theme] of [
    ['a light theme', basicLight],
    ['a dark theme', basicDark],
  ] as const)
    it(`keeps the message legible under ${name}`, async () => {
      const view = mount('nope 1', {}, theme);
      await compiled(view);
      await waitFor('the linter to run', () => reported(view).length > 0);
      openLintPanel(view);
      await waitFor('the panel to open', () => !!document.querySelector('.cm-diagnostic'));

      const { color, backgroundColor } = getComputedStyle(
        document.querySelector('.cm-diagnostic')!,
      );
      const [text, behind] = [luminance(color), luminance(backgroundColor)];
      expect(behind).toBeDefined();
      expect(Math.abs(text! - behind!)).toBeGreaterThan(0.5);
    });
});

/** Rough relative brightness, enough to tell text from its background apart. */
function luminance(color: string): number | undefined {
  const parts = color.match(/\d+(\.\d+)?/g);
  if (!parts || parts.length < 3) return undefined;
  const [r, g, b] = parts.map(Number);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}
