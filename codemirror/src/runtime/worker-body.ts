// The worker's protocol. Bundled into one script with no imports left in it,
// because it is started from a blob: nothing to resolve means neither a bundler
// nor an import map can get it wrong, and import maps do not reach workers at
// all.

import type { Compiled } from '../dag';
import type { Value } from '../tree';
import { makeMachine } from './machine.js';

const machine = makeMachine();
let compiler: ReturnType<typeof machine.ofDag> | null = null;

function compile(source: string): Compiled {
  if (!compiler) throw new Error('compiler not loaded');
  machine.steps.count = 0;
  const out = machine.toString(machine.apply(compiler, machine.ofString(source)));
  const dagLines = out.split(/\r?\n/);
  // A source it cannot read is what the compiler answers with nothing at all,
  // rather than by failing. Said here, where the emptiness means something,
  // rather than by whatever reads the result.
  if (dagLines.every((line) => line.trim() === '')) throw new Error('syntax error');
  return { dagLines, steps: machine.steps.count };
}

// A tree and nothing else: what a value stands for is the caller's to decide,
// and this end of it never guesses. It goes back flat, as indices, because a
// message out of a worker is copied by a recursive walk and a value is deeper
// than that walk can go. The cost is all in `toNodes`, since `apply` only
// conses and nothing reduces until something forces it.
function run(dag: string): Value {
  machine.steps.count = 0;
  const { nodes, root } = machine.toNodes(machine.ofDag(dag));
  return { nodes, root, steps: machine.steps.count };
}

interface Request {
  id: number;
  type: 'load' | 'compile' | 'run';
  payload: string;
}

self.addEventListener('message', (e: MessageEvent<Request>) => {
  const { id, type, payload } = e.data;
  try {
    switch (type) {
      case 'load':
        compiler = machine.ofDag(payload);
        // Forcing one compilation here rather than on the first keystroke: the
        // compiler is a tree, and the first application is what evaluates it.
        compile('△');
        self.postMessage({ id, ok: true, result: null });
        break;
      case 'compile':
        self.postMessage({ id, ok: true, result: compile(payload) });
        break;
      case 'run':
        self.postMessage({ id, ok: true, result: run(payload) });
        break;
      default:
        throw new Error(`unknown request: ${type}`);
    }
  } catch (error) {
    self.postMessage({
      id,
      ok: false,
      error: `${error instanceof Error ? error.message : error}`,
    });
  }
});
