// The wiring under a block preview's wrap, driven by hand. What a real
// ResizeObserver reports, and when, is the browser's; which calls are made —
// and what the first real box does to the floor — is ours, and holds with the
// globals stubbed out.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { floored } from '../src/previews';

class StubElement {
  className = '';
  style = { minHeight: '' };
  children: StubElement[] = [];
  appendChild(child: StubElement): void {
    this.children.push(child);
  }
}

type Entry = { contentRect: { width: number; height: number } };

class StubObserver {
  static instances: StubObserver[] = [];
  observed: unknown[] = [];
  disconnected = 0;
  constructor(readonly callback: (entries: Entry[]) => void) {
    StubObserver.instances.push(this);
  }
  observe(target: unknown): void {
    this.observed.push(target);
  }
  disconnect(): void {
    this.disconnected += 1;
  }
  report(width: number, height: number): void {
    this.callback([{ contentRect: { width, height } }]);
  }
}

(globalThis as { document?: unknown }).document = {
  createElement: () => new StubElement(),
};
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = StubObserver;

function setup(height = 96) {
  const element = new StubElement();
  const { wrap, release } = floored(element as unknown as HTMLElement, height);
  return {
    element,
    wrap: wrap as unknown as StubElement,
    release,
    watcher: StubObserver.instances[StubObserver.instances.length - 1],
  };
}

test('the wrap is floored at the estimate and the element watched', () => {
  const { element, wrap, watcher } = setup();
  assert.equal(wrap.className, 'cm-preview-block');
  assert.equal(wrap.style.minHeight, '96px');
  assert.deepEqual(wrap.children, [element]);
  assert.deepEqual(watcher.observed, [element]);
});

test('a report of no box leaves the floor standing', () => {
  const { wrap, watcher } = setup();
  watcher.report(0, 0);
  assert.equal(wrap.style.minHeight, '96px');
  assert.equal(watcher.disconnected, 0);
});

test('a width without a height is not the content taking the room', () => {
  const { wrap, watcher } = setup();
  watcher.report(300, 0);
  assert.equal(wrap.style.minHeight, '96px');
  assert.equal(watcher.disconnected, 0);
});

test('the first real box takes the floor down and ends the watch', () => {
  const { wrap, watcher } = setup();
  watcher.report(300, 40);
  assert.equal(wrap.style.minHeight, '');
  assert.equal(watcher.disconnected, 1);
});

test('release before any report ends the watch', () => {
  const { wrap, release, watcher } = setup();
  release();
  assert.equal(watcher.disconnected, 1);
  assert.equal(wrap.style.minHeight, '96px');
});
