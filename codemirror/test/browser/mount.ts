import { basicSetup } from 'codemirror';
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach } from 'vitest';

import { lambada, lambadaCompilations, type LambadaConfig } from '../../src/index';
import { lambadaStatements } from '../../src/statements';

const open: EditorView[] = [];

afterEach(() => {
  // Destroying is what stops the workers; leaving them running would have
  // every later test racing a compiler it did not start.
  while (open.length) open.pop()!.destroy();
  document.body.replaceChildren();
});

export function mount(
  doc: string,
  config: LambadaConfig = {},
  extra: Extension = [],
): EditorView {
  const parent = document.body.appendChild(document.createElement('div'));
  const view = new EditorView({
    doc,
    extensions: [basicSetup, lambada(config), extra],
    parent,
  });
  open.push(view);
  return view;
}

export async function waitFor(what: string, ready: () => boolean, timeout = 20_000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    if (ready()) return;
    await new Promise((resume) => setTimeout(resume, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Every statement compiled, or failed to. Nothing is drawn before that. */
export async function compiled(view: EditorView) {
  await waitFor('the document to compile', () => {
    const known = view.state.field(lambadaCompilations);
    const statements = view.state.field(lambadaStatements);
    return (
      statements.length > 0 &&
      statements.every((s) => (known.get(s.text)?.status ?? 'pending') !== 'pending')
    );
  });
}

export const lines = () => [...document.querySelectorAll('.cm-line')];

export const statusOf = (line: Element) =>
  line.className.match(/cm-statement-(\w+)/)?.[1] ?? null;
