import {
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
} from '@codemirror/state';
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';

import { workerSource } from './generated/worker-source';

/** Asked for, then either what came back or why nothing did. */
export type Outcome<T> =
  | { status: 'pending' }
  | ({ status: 'ok' } & T)
  | { status: 'error'; message: string };

/**
 * How many answers to keep after they stop being wanted. Enough for a document
 * to stop wanting all of them and want them all back, which is what an edit
 * near the top does, and few enough that a long-lived editor does not hold on
 * to everything it has ever been shown.
 */
const spares = 32;

/** Told once per page: both workers fail for the same reason, together. */
let blamed = false;

/**
 * Questions asked of a worker of its own, one at a time. Which question is the
 * `action`: statements to compile, or expressions to evaluate.
 *
 * The worker is started from a blob rather than a URL: the source has no
 * imports, so there is nothing for a bundler or an import map to resolve, and
 * the same code works whether a host bundles this package or serves it as
 * files. A host with a content security policy has to allow `blob:` workers —
 * `worker-src`, `child-src` or `script-src` will each do it.
 *
 * Killing the worker is the only way to stop one: reducing a tree is one
 * synchronous loop, so nothing in the page can interrupt it.
 */
class Jobs<T> {
  #worker: Worker | null = null;
  #url: string;
  #dag: string;
  #action: 'compile' | 'run';
  #timeoutMs: number;
  #onChange: () => void;

  #results = new Map<string, Outcome<T>>();
  #spare = new Map<string, Outcome<T>>();
  #queue: string[] = [];
  #inFlight: { text: string; timer: ReturnType<typeof setTimeout> } | null = null;
  #loaded = false;
  #destroyed = false;

  constructor(
    dag: string,
    timeoutMs: number,
    onChange: () => void,
    action: 'compile' | 'run' = 'compile',
  ) {
    this.#dag = dag;
    this.#action = action;
    this.#timeoutMs = timeoutMs;
    this.#onChange = onChange;
    this.#url = URL.createObjectURL(
      new Blob([workerSource], { type: 'text/javascript' }),
    );
    this.#spawn();
  }

  /** What is known about this input, if anything. */
  get(text: string): Outcome<T> | undefined {
    return this.#results.get(text);
  }

  /** Ask, unless the answer is already to hand. */
  request(text: string): void {
    if (this.#destroyed || this.#results.has(text)) return;
    const kept = this.#spare.get(text);
    if (kept) {
      // Asked for again, and the answer never stopped being true.
      this.#spare.delete(text);
      this.#results.set(text, kept);
      return;
    }
    this.#results.set(text, { status: 'pending' });
    this.#queue.push(text);
    this.#pump();
  }

  /**
   * Drop everything no longer in `keep`. Work already in flight is left to
   * finish or to time out rather than cancelled: nothing in the page can
   * interrupt the thread, so cancelling means killing it, and a compilation
   * costs single-digit milliseconds where a respawn costs far more.
   *
   * An answer that had been reached is set aside rather than thrown away. The
   * same input always evaluates to the same thing, so keeping one is only ever
   * a question of room — and a statement stops being wanted for a moment every
   * time one above it is edited, which is exactly when the document is about to
   * ask for it again.
   */
  retain(keep: ReadonlySet<string>): void {
    for (const [text, value] of this.#results)
      if (!keep.has(text)) {
        this.#results.delete(text);
        if (value.status !== 'pending') this.#setAside(text, value);
      }
    this.#queue = this.#queue.filter((text) => keep.has(text));
  }

  #setAside(text: string, value: Outcome<T>): void {
    // Re-inserting moves it to the end, so the oldest is the first one out.
    this.#spare.delete(text);
    this.#spare.set(text, value);
    for (const oldest of this.#spare.keys()) {
      if (this.#spare.size <= spares) break;
      this.#spare.delete(oldest);
    }
  }

  destroy(): void {
    this.#destroyed = true;
    this.#clearTimer();
    this.#worker?.terminate();
    this.#worker = null;
    URL.revokeObjectURL(this.#url);
  }

  #spawn(): void {
    this.#worker = new Worker(this.#url);
    this.#loaded = false;
    this.#worker.addEventListener('message', this.#onMessage);
    this.#worker.addEventListener('error', this.#onError);
    this.#worker.postMessage({ id: 'load', type: 'load', payload: this.#dag });
  }

  #clearTimer(): void {
    if (this.#inFlight) clearTimeout(this.#inFlight.timer);
    this.#inFlight = null;
  }

  #settle(text: string, value: Outcome<T>): void {
    // Only record what is still wanted; a document may have moved on.
    if (this.#results.has(text)) this.#results.set(text, value);
    this.#onChange();
  }

  #onMessage = (event: MessageEvent): void => {
    const { id, ok, result, error } = event.data;
    if (id === 'load') {
      this.#loaded = true;
      this.#pump();
      return;
    }
    const current = this.#inFlight;
    if (!current) return;
    this.#clearTimer();
    if (!ok) this.#settle(current.text, { status: 'error', message: String(error) });
    else this.#settle(current.text, { status: 'ok', ...result });
    this.#pump();
  };

  #onError = (): void => {
    // The worker did not start. A content security policy forbidding `blob:`
    // is much the likeliest reason, and retrying would only fail again.
    //
    // Nothing gets marked: the statements are not wrong, there is just nothing
    // to say about them, and marking every line red would claim otherwise.
    if (this.#destroyed) return;
    if (!blamed) {
      blamed = true;
      console.warn(
        'lambada: a worker could not be started, so nothing will be compiled ' +
          'or evaluated. A content security policy has to allow blob: workers ' +
          '— worker-src, child-src or script-src will each do it.',
      );
    }
    this.#clearTimer();
    this.#queue = [];
    this.#results.clear();
    this.#spare.clear();
    this.#destroyed = true;
    this.#onChange();
  };

  #pump(): void {
    if (this.#destroyed || !this.#loaded || this.#inFlight) return;
    const text = this.#queue.shift();
    if (text === undefined) return;
    if (!this.#results.has(text)) {
      this.#pump();
      return;
    }
    const timer = setTimeout(() => this.#timeOut(), this.#timeoutMs);
    this.#inFlight = { text, timer };
    this.#worker!.postMessage({ id: this.#action, type: this.#action, payload: text });
  }

  #timeOut(): void {
    const current = this.#inFlight;
    this.#inFlight = null;
    this.#worker?.removeEventListener('message', this.#onMessage);
    this.#worker?.removeEventListener('error', this.#onError);
    this.#worker?.terminate();
    if (current)
      this.#settle(current.text, {
        status: 'error',
        message: `took too long to ${this.#action === 'run' ? 'evaluate' : 'compile'}`,
      });
    this.#spawn();
  }
}

/**
 * A worker's answers, in the editor's state, keyed by what was asked.
 *
 * Both of this package's workers are driven the same way: ask for whatever the
 * document wants, forget what it has stopped wanting, and put the answers into
 * the state once they arrive. All that differs is the question — statements to
 * compile, expressions to evaluate — which is what `wanted` names.
 *
 * The field is made here and the plugin separately, because the field is a
 * document's own and exists whether or not anything is configured to fill it,
 * while the plugin needs the configuration.
 */
export function results<T>(action: 'compile' | 'run') {
  /** Carries answers from the worker into the state. */
  const setResults = StateEffect.define<ReadonlyMap<string, Outcome<T>>>();

  const field = StateField.define<ReadonlyMap<string, Outcome<T>>>({
    create: () => new Map(),
    update(value, tr) {
      for (const effect of tr.effects) if (effect.is(setResults)) return effect.value;
      return value;
    },
  });

  /** Keep [field] holding an answer for everything `wanted` names, and nothing else. */
  const keep = (
    { compiler, timeout }: { compiler: string; timeout: number },
    wanted: (state: EditorState) => Iterable<string>,
  ): Extension =>
    ViewPlugin.fromClass(
      class {
        jobs: Jobs<T>;
        queued = false;
        dead = false;

        constructor(readonly view: EditorView) {
          this.jobs = new Jobs<T>(compiler, timeout, () => this.schedule(), action);
          this.sync();
        }

        // What is wanted is read off the state, so an edit can change it — and
        // so can an answer landing, which arrives as an effect: the expressions
        // worth evaluating are the ones the compilations turned out to be.
        update(update: ViewUpdate) {
          if (update.docChanged || update.transactions.some((tr) => tr.effects.length))
            this.sync();
        }

        /** Ask for anything not yet asked for, and forget what is gone. */
        sync() {
          const keys = new Set(wanted(this.view.state));
          this.jobs.retain(keys);
          for (const key of keys) this.jobs.request(key);
          this.schedule();
        }

        /**
         * Never dispatches where it is called from. A plugin is constructed and
         * updated inside an update, and starting another one there throws — and
         * a worker that fails to start reports it early enough to land inside
         * that same update, so a microtask is not late enough to help.
         */
        schedule() {
          if (this.queued || this.dead) return;
          this.queued = true;
          setTimeout(() => {
            this.queued = false;
            if (!this.dead) this.publish();
          }, 0);
        }

        publish() {
          const next = new Map<string, Outcome<T>>();
          for (const key of wanted(this.view.state)) {
            const value = this.jobs.get(key);
            if (value) next.set(key, value);
          }
          if (same(next, this.view.state.field(field))) return;
          this.view.dispatch({ effects: setResults.of(next) });
        }

        destroy() {
          this.dead = true;
          this.jobs.destroy();
        }
      },
    );

  return { field, keep };
}

/** The same questions, settled the same way — so there is nothing to announce. */
function same<T>(
  a: ReadonlyMap<string, Outcome<T>>,
  b: ReadonlyMap<string, Outcome<T>>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    const other = b.get(key);
    if (!other || other.status !== value.status) return false;
  }
  return true;
}
