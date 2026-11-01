'use strict';

// An interactive session: LambAda in, values out, against an environment of
// DAG files.
//
// A session is a source that grows. Each input is compiled after everything
// accepted before it, so earlier definitions are in scope and a later one
// hides an earlier one of the same name, exactly as in a file. What the input
// adds as bare expressions is evaluated and shown; the compiler names each
// after the code line it ends on, which is how the new ones are told from the
// old. Names the input uses but neither it, the session nor the environment
// defines are reported before anything runs.
//
// A result is shown through `_to_string` when the session defines one, as an
// expect test is, and otherwise in a format of the runtime's (`term` unless
// asked otherwise). A file — △ (△ <name> <media type>) <bytes> — is described
// rather than dumped.
//
// Evaluation runs in a worker thread holding the environment, so a term that
// does not finish can be stopped (Ctrl-C, or --timeout) without losing the
// session: the worker is replaced and the expressions after the stopped one
// still run.

const { readFileSync } = require('fs');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const { physical_lines } = require('./project.js');

// As in compile.js: a bare expression's value is named after the code line its
// statement ends on, and a statement that did not compile is recorded the same way.
const LINE = /^:line\.(\d+)$/;
const FAIL = /^:fail\.(\d+) /gm;

// The runtime's text formats; `buffer` is bytes, not text.
const FORMATS = ['term', 'nat', 'string', 'bool', 'ternary', 'dag', 'minbin'];

const HELP = `Enter a definition (name = expression) or an expression to evaluate.
  :{ … :}           a multi-line input
  :format <f>       show results as ${FORMATS.join(', ')} (now: %FORMAT%);
                    a definition of _to_string takes precedence, as in expect tests
  :names [prefix]   the environment's names, or those starting with prefix
  :load <file>      add a source's definitions, and show its expressions
  :reset            forget this session's definitions
  :quit             leave (also Ctrl-D)
Ctrl-C stops an evaluation that does not finish.`;

/** Where an input went wrong, as opposed to the environment or the runtime. */
class InputError extends Error {}

/**
 * What evaluates inputs against one environment: the session's own logic,
 * without threads, so it can be driven directly (tests) or from a worker.
 */
function session_evaluator({ runtime, environment: paths, compiler, prelude: prelude_path }) {
  const { DagModule, LEAF, box, environment, evaluator, formatters, interface_of, link, marshal, to_file } = runtime;
  const texts = paths.map(name => ({ name, text: readFileSync(name, 'utf8') }));
  const library = texts.length === 1 ? texts[0].text : link(texts);
  const get = environment(evaluator, library, { origin: paths.join(' + ') || 'environment' });
  const compile_file = runtime.transformer(evaluator, readFileSync(compiler, 'utf8'));
  const prelude = readFileSync(prelude_path, 'utf8');

  // What the environment defines, by name: the bindings it can resolve.
  const defined = new Set([LEAF]);
  for (const line of library.split('\n')) {
    const words = line.trim().split(/\s+/);
    if (words.length === 2 || words.length === 3) defined.add(words[0]);
  }
  const names = [...defined].filter(name => /^[A-Za-z_]/.test(name)).sort();

  const not_a_pair = () => { throw new Error('expected a pair'); };
  const halves = evaluator.triage(not_a_pair, not_a_pair, (raw, shown) => [raw, shown]);
  const text_of = bytes => new TextDecoder().decode(bytes);

  /**
   * Compile `session` followed by `input`, and return the expressions `input`
   * adds, each ready to evaluate. Throws an InputError naming the input's own
   * line for a statement that does not compile or a name nothing defines.
   */
  function prepare(session, input) {
    const source = session + input;
    const session_lines = session.split('\n').length - 1;
    const out = compile_file(source);
    const failed = [...out.matchAll(FAIL)].map(([, n]) => physical_lines(source)[Number(n)] - session_lines);
    if (failed.length) {
      throw new InputError(`${failed.map(n => `line ${n}`).join(', ')}: the statement ending here does not compile`);
    }
    const text = prelude + out;
    const unknown = interface_of(text).imports.filter(name => !defined.has(name));
    if (unknown.length) throw new InputError(`not defined: ${unknown.join(', ')}`);

    // Code lines are what the compiler numbers expressions by; those past the
    // session's are this input's. Each is shown through whichever _to_string
    // precedes it, as in a file.
    const offset = physical_lines(session).length - 1;
    const module = DagModule.parse(text, { absorb_internal_aliases: false });
    const lines = [];
    const expressions = [];
    let to_string = null;
    for (const line of module.lines) {
      lines.push(line);
      if (line.length > 1 && line[0].symbol === '_to_string') to_string = line[0];
      const test = line.length === 2 && LINE.exec(line[0].symbol);
      if (!test || Number(test[1]) <= offset) continue;
      const at = Number(test[1]);
      const expression = { line: physical_lines(source)[at] - session_lines, value: line[0].symbol };
      if (to_string) {
        // One fork of the value and the value shown, so that showing it does
        // not compute it a second time; the value is what a file is told by.
        const [shown, stem, pair] = [box(`:shown.${at}`), box(`:stem.${at}`), box(`:pair.${at}`)];
        lines.push([shown, to_string, line[0]], [stem, box(LEAF), line[0]], [pair, stem, shown]);
        expression.pair = pair.symbol;
      }
      expressions.push(expression);
    }
    module.lines = lines;
    return expressions.map(expression => ({ ...expression, module }));
  }

  /** One prepared expression, evaluated and shown as text. */
  function show({ module, value, pair }, format) {
    const reduce = symbol => get.reduce(module.extract([symbol]).toString());
    const [raw, shown] = pair ? halves(reduce(pair)) : [reduce(value), null];
    const file = to_file(evaluator, raw);
    if (file) return `file ${file.name} (${file.media_type}, ${file.bytes.length} bytes)`;
    if (shown) return marshal.to_string(shown);
    try {
      return text_of(formatters[format].to(raw));
    } catch (error) {
      if (format === 'term') throw error;
      throw new Error(`not a ${format} (${error.message}); as a term: ${text_of(formatters.term.to(raw))}`);
    }
  }

  return { prepare, show, names, defined };
}

// ---- the worker: one environment, inputs one at a time -----------------------

/** A worker thread's side: build the evaluator once, then answer requests. */
function serve({ tree_calculus, ...options }) {
  let evaluator;
  try {
    evaluator = session_evaluator({ runtime: require('./runtime.js').load(tree_calculus), ...options });
  } catch (error) {
    parentPort.postMessage({ fatal: error.message });
    return;
  }
  parentPort.postMessage({ ready: evaluator.names.length });
  parentPort.on('message', ({ id, kind, session, input, from = 0, format, prefix }) => {
    if (kind === 'names') {
      parentPort.postMessage({ id, names: evaluator.names.filter(name => name.startsWith(prefix ?? '')) });
      return;
    }
    let expressions;
    try {
      expressions = evaluator.prepare(session, input);
    } catch (error) {
      parentPort.postMessage({ id, error: error.message, input_error: error instanceof InputError });
      return;
    }
    parentPort.postMessage({ id, compiled: expressions.map(({ line }) => line) });
    for (let index = from; index < expressions.length; index++) {
      try {
        parentPort.postMessage({ id, index, text: evaluator.show(expressions[index], format) });
      } catch (error) {
        parentPort.postMessage({ id, index, error: error.message });
      }
    }
    parentPort.postMessage({ id, done: true });
  });
}

/**
 * The worker, replaceable: `stop` terminates the current one and starts a
 * fresh one reading the same environment.
 */
function worker_pool(options) {
  let worker = null;
  let ready = null;
  let listener = null;
  const start = () => {
    worker = new Worker(__filename, { workerData: { repl: options } });
    ready = new Promise((ok, fail) => {
      worker.once('message', message => message.fatal ? fail(new Error(message.fatal)) : ok(message.ready));
      worker.once('error', fail);
    });
    worker.on('message', message => listener && message.id !== undefined && listener(message));
  };
  start();
  return {
    ready: () => ready,
    request(message, on_message) {
      listener = on_message;
      worker.postMessage(message);
    },
    async stop() {
      listener = null;
      await worker.terminate();
      start();
      await ready;
    },
    close: () => worker.terminate(),
  };
}

// ---- the session ------------------------------------------------------------

async function repl({ runtime, environment = [], compiler, prelude, format = 'term', evals = [], timeout, tree_calculus }) {
  if (!FORMATS.includes(format)) throw new Error(`unknown format ${format} (one of ${FORMATS.join(', ')})`);
  const interactive = !evals.length && process.stdin.isTTY;
  const pool = worker_pool({ environment, compiler, prelude, tree_calculus });
  const count = await pool.ready();
  if (interactive) {
    console.log(`LambAda, with ${count} names from ${environment.length ? environment.join(', ') : 'no environment'}. :help for help.`);
  }

  let session = '';
  let failures = 0;
  let next_id = 0;
  const say_error = text => { failures++; console.error(text); };

  // Run one input to the end: show each of its expressions, and on a stopped
  // one (timeout, Ctrl-C) start a fresh worker and carry on after it.
  let stop_current = null;
  async function run(input) {
    if (!input.trim()) return;
    if (!input.endsWith('\n')) input += '\n';
    const before = session;
    let from = 0;
    for (;;) {
      const outcome = await new Promise(settle => {
        const id = next_id++;
        let lines = [];
        let current = from;
        let timer = null;
        const finish = outcome => { clearTimeout(timer); settle(outcome); };
        const stopped = reason => () => finish({ stopped: reason, at: current, lines });
        stop_current = stopped('interrupted');
        pool.request({ id, kind: 'run', session: before, input, from, format }, message => {
          if (message.error && message.index === undefined) return finish({ error: message.error });
          if (message.done) return finish({ done: true });
          if (message.compiled) {
            lines = message.compiled;
            session = before + input;
          } else {
            if (message.error) say_error(`${where(lines, message.index)}${message.error}`);
            else console.log(message.text);
            current = message.index + 1;
          }
          if (timeout) {
            clearTimeout(timer);
            timer = setTimeout(stopped(`did not finish within ${timeout} s`), timeout * 1000);
          }
        });
      });
      stop_current = null;
      if (outcome.error) return say_error(outcome.error);
      if (outcome.done) return;
      say_error(`${where(outcome.lines, outcome.at)}${outcome.stopped}`);
      await pool.stop();
      from = outcome.at + 1;
      if (from >= outcome.lines.length) return;
    }
  }
  const where = (lines, index) => (lines.length > 1 ? `line ${lines[index]}: ` : '');

  async function names(prefix) {
    const found = await new Promise(ok => pool.request({ id: next_id++, kind: 'names', prefix }, message => ok(message.names)));
    console.log(found.length ? found.join('  ') : `no names start with ${prefix}`);
  }

  // A line starting with ':' is a command; everything else is LambAda.
  async function handle(input) {
    const command = /^:(\w+)\s*(.*)$/s.exec(input.trim());
    if (!command) return run(input);
    const [, name, argument] = command;
    if (name === 'help') console.log(HELP.replace('%FORMAT%', format));
    else if (name === 'quit' || name === 'q') return 'quit';
    else if (name === 'reset') session = '';
    else if (name === 'names') await names(argument.trim());
    else if (name === 'load') {
      let text;
      try { text = readFileSync(argument.trim(), 'utf8'); } catch (error) { return say_error(error.message); }
      await run(text);
    } else if (name === 'format') {
      if (!FORMATS.includes(argument.trim())) say_error(`unknown format ${argument.trim()} (one of ${FORMATS.join(', ')})`);
      else format = argument.trim();
    } else say_error(`unknown command :${name} (:help lists them)`);
  }

  try {
    if (evals.length) {
      for (const input of evals) await run(input);
    } else if (!interactive) {
      // Piped in: the whole of it is one source, expressions shown in order.
      await run(readFileSync(0, 'utf8'));
    } else {
      await interact(handle, () => stop_current);
    }
  } finally {
    await pool.close();
  }
  return failures;
}

/**
 * The interactive loop: a prompt, history, `:{ … :}` blocks and Ctrl-C.
 *
 * Input keeps being read while an evaluation runs — in raw mode Ctrl-C is a
 * keypress, so pausing the input would leave nothing to stop it with — and
 * lines typed meanwhile wait their turn.
 */
function interact(handle, current) {
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'λ> ' });
  const queue = [];
  let block = null;
  let busy = false;
  return new Promise(done => {
    let closed = false;
    rl.on('SIGINT', () => {
      const stop = current();
      if (stop) return stop();
      queue.length = 0;
      if (block) { block = null; rl.setPrompt('λ> '); }
      process.stdout.write('\n(:quit or Ctrl-D to leave)\n');
      rl.prompt();
    });
    rl.on('close', () => { closed = true; if (!busy) finish(); });
    rl.on('line', line => {
      if (block) {
        if (line.trim() !== ':}') { block.push(line); return rl.prompt(); }
        queue.push(block.join('\n'));
        block = null;
        rl.setPrompt('λ> ');
      } else if (line.trim() === ':{') {
        block = [];
        rl.setPrompt('.. ');
        return rl.prompt();
      } else {
        queue.push(line);
      }
      pump();
    });
    const finish = () => { process.stdout.write('\n'); done(); };
    async function pump() {
      if (busy) return;
      busy = true;
      while (queue.length) {
        if (await handle(queue.shift()) === 'quit') { queue.length = 0; closed = true; rl.close(); }
      }
      busy = false;
      if (closed) return finish();
      rl.prompt();
    }
    rl.prompt();
  });
}

// Declared last, below everything it reaches: this file is its own worker
// entry, and a `const` above would still be in its dead zone on that thread.
if (!isMainThread && workerData && workerData.repl) serve(workerData.repl);

module.exports = { repl, session_evaluator, InputError, FORMATS };
