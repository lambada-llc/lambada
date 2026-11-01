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
//
// The session is kept as the inputs it accepted, so `:undo` takes back the
// last ones and the session is what remains.

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
An input that ends unfinished continues on an indented line (..), until it
compiles or an empty line ends it. Alt-Enter starts a new line without running
the input, and a pasted block runs as one input.
  :format <f>       show results as ${FORMATS.join(', ')} (now: %FORMAT%);
                    a definition of _to_string takes precedence, as in expect tests
  :names [prefix]   the environment's names, or those starting with prefix
  :load <file>      add a source's definitions, and show its expressions
  :undo [n]         take back the last input, or the last n
  :quit             leave (also Ctrl-D)
Ctrl-C stops an evaluation that does not finish, or drops an unfinished input.`;

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
   * line for a statement that does not compile or a name nothing defines; it is
   * `unfinished` when the statement that does not compile is the last, which
   * more lines might complete.
   */
  function prepare(session, input) {
    const source = session + input;
    const session_lines = session.split('\n').length - 1;
    const code = physical_lines(source);
    const out = compile_file(source);
    const failed = [...out.matchAll(FAIL)].map(([, n]) => code[Number(n)] - session_lines);
    if (failed.length) {
      const error = new InputError(`${failed.map(n => `line ${n}`).join(', ')}: the statement ending here does not compile`);
      error.unfinished = failed.includes(code[code.length - 1] - session_lines);
      throw error;
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
      const expression = { line: code[at] - session_lines, value: line[0].symbol };
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
      parentPort.postMessage({ id, error: error.message, unfinished: Boolean(error.unfinished) });
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

  const inputs = [];
  let failures = 0;
  let next_id = 0;
  const say_error = text => { failures++; console.error(text); };

  // Run one input to the end: show each of its expressions, and on a stopped
  // one (timeout, Ctrl-C) start a fresh worker and carry on after it. With
  // `more`, an unfinished input is left unreported and answered 'more'.
  let stop_current = null;
  async function run(input, more = false) {
    if (!input.trim()) return;
    if (!input.endsWith('\n')) input += '\n';
    const before = inputs.join('');
    let accepted = false;
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
          if (message.error && message.index === undefined) return finish(message);
          if (message.done) return finish({ done: true });
          if (message.compiled) {
            lines = message.compiled;
            if (!accepted) inputs.push(input);
            accepted = true;
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
      if (outcome.error) return more && outcome.unfinished ? 'more' : say_error(outcome.error);
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
  async function handle(input, more) {
    const command = /^:(\w+)\s*(.*)$/s.exec(input.trim());
    if (!command) return run(input, more);
    const [, name, argument] = command;
    if (name === 'help') console.log(HELP.replace('%FORMAT%', format));
    else if (name === 'quit' || name === 'q') return 'quit';
    else if (name === 'undo') {
      const count = Number(argument.trim() || 1);
      if (!Number.isInteger(count) || count < 1) say_error(`:undo takes a count, not ${argument.trim()}`);
      else if (!inputs.length) console.log('nothing to undo');
      else for (const input of inputs.splice(-count).reverse()) console.log(`undid ${input.trimEnd()}`);
    }
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
 * The interactive loop: a prompt, history, multi-line inputs and Ctrl-C.
 *
 * Input keeps being read while an evaluation runs — in raw mode Ctrl-C is a
 * keypress, so pausing the input would leave nothing to stop it with — and
 * lines typed meanwhile wait their turn.
 *
 * A line either runs, joined to the unfinished lines before it, or is held to
 * be joined to the next: held when it ends with Alt-Enter, which readline
 * leaves alone, or arrives inside a bracketed paste. A continuation line
 * starts indented, since that is what continues a statement in a source.
 */
function interact(handle, current) {
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'λ> ' });
  const queue = [];
  let pending = [];
  let hold = false;
  let pasting = false;
  let busy = false;
  const on_key = (_, key = {}) => {
    if (key.name === 'paste-start' || key.name === 'paste-end') pasting = key.name === 'paste-start';
    else if (key.name === 'return' && key.meta) { hold = true; rl.write('\r'); }
  };
  process.stdin.on('keypress', on_key);
  if (rl.terminal) process.stdout.write('\x1b[?2004h');
  return new Promise(done => {
    let closed = false;
    const prompt = () => {
      rl.setPrompt(pending.length ? '.. ' : 'λ> ');
      rl.prompt();
      if (pending.length && !pasting) rl.write('  ');
    };
    rl.on('SIGINT', () => {
      const stop = current();
      if (stop) return stop();
      queue.length = 0;
      if (pending.length) pending = [];
      else process.stdout.write('\n(:quit or Ctrl-D to leave)');
      process.stdout.write('\n');
      rl.line = '';
      prompt();
    });
    rl.on('close', () => { closed = true; if (!busy) finish(); });
    rl.on('line', line => {
      queue.push({ line, held: hold || pasting });
      hold = false;
      pump();
    });
    const finish = () => {
      process.stdin.off('keypress', on_key);
      if (rl.terminal) process.stdout.write('\x1b[?2004l');
      process.stdout.write('\n');
      done();
    };
    async function pump() {
      if (busy) return;
      busy = true;
      while (queue.length) {
        const { line, held } = queue.shift();
        const lines = [...pending, line];
        if (held) { pending = lines; continue; }
        // An empty line says the input is finished, whether it compiles or not,
        // and is not part of it.
        const more = line.trim() !== '';
        const outcome = await handle((more ? lines : pending).join('\n'), more);
        if (outcome === 'quit') { queue.length = 0; closed = true; rl.close(); }
        pending = outcome === 'more' ? lines : [];
      }
      busy = false;
      if (closed) return finish();
      prompt();
    }
    prompt();
  });
}

// Declared last, below everything it reaches: this file is its own worker
// entry, and a `const` above would still be in its dead zone on that thread.
if (!isMainThread && workerData && workerData.repl) serve(workerData.repl);

module.exports = { repl, session_evaluator, InputError, FORMATS };
