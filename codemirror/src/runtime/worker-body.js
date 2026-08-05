// The worker's protocol. Concatenated after `machine.js`, which is why it can
// call `makeMachine` without importing it — and why the whole thing can be
// handed to `new Worker` as a blob. Nothing to resolve means neither a bundler
// nor an import map can get it wrong, and import maps do not reach workers at
// all.

const machine = makeMachine();
let compiler = null;

function compile(source) {
  if (!compiler) throw new Error('compiler not loaded');
  machine.steps.count = 0;
  const out = machine.toString(machine.apply(compiler, machine.ofString(source)));
  return { dagLines: out.split(/\r?\n/), steps: machine.steps.count };
}

// A tree and nothing else: what a value stands for is the caller's to decide,
// and this end of it never guesses. It goes back flat, as indices, because a
// message out of a worker is copied by a recursive walk and a value is deeper
// than that walk can go. The cost is all in `toNodes`, since `apply` only
// conses and nothing reduces until something forces it.
function run(dag) {
  machine.steps.count = 0;
  const { nodes, root } = machine.toNodes(machine.ofDag(dag));
  return { nodes, root, steps: machine.steps.count };
}

self.addEventListener('message', (e) => {
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
    self.postMessage({ id, ok: false, error: `${error && error.message ? error.message : error}` });
  }
});
