import { workerSource } from './generated/worker-source';
import type { Value } from './tree';

/** Asked for, then either what came back or why nothing did. */
export type Outcome<T> =
  | { status: 'pending' }
  | ({ status: 'ok' } & T)
  | { status: 'error'; message: string };

/** What the compiler produced for one statement. */
export type Compilation = Outcome<{
  dagLines: readonly string[];
  steps: number;
}>;

export type Evaluation = Outcome<Value>;

/**
 * A compiler running on a worker of its own.
 *
 * The worker is started from a blob rather than a URL: the source has no
 * imports, so there is nothing for a bundler or an import map to resolve, and
 * the same code works whether a host bundles this package or serves it as
 * files. A host with a content security policy has to allow `blob:` workers —
 * `worker-src`, `child-src` or `script-src` will each do it.
 *
 * Killing the worker is the only way to stop a compilation: evaluating a tree
 * is one synchronous loop, so nothing in the page can interrupt it.
 */
export class Compiler<T> {
  #worker: Worker | null = null;
  #url: string;
  #dag: string;
  #action: 'compile' | 'run';
  #timeoutMs: number;
  #onChange: () => void;

  #results = new Map<string, Outcome<T>>();
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

  /** Ask for a compilation, unless one has already been asked for. */
  request(text: string): void {
    if (this.#destroyed || this.#results.has(text)) return;
    this.#results.set(text, { status: 'pending' });
    this.#queue.push(text);
    this.#pump();
  }

  /**
   * Forget everything no longer in `keep`. Work already in flight is left to
   * finish rather than cancelled: a compilation costs single-digit
   * milliseconds, and restarting the worker to save one costs far more.
   */
  retain(keep: ReadonlySet<string>): void {
    for (const text of this.#results.keys())
      if (!keep.has(text)) this.#results.delete(text);
    this.#queue = this.#queue.filter((text) => keep.has(text));
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
    else if (this.#action === 'compile' && isEmpty(result.dagLines))
      // The compiler reports a source it cannot read by producing nothing at
      // all, rather than by failing.
      this.#settle(current.text, { status: 'error', message: 'syntax error' });
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
    console.warn(
      'lambada: the compiler worker could not be started, so nothing will be ' +
        'compiled. A content security policy has to allow blob: workers — ' +
        'worker-src, child-src or script-src will each do it.',
    );
    this.#clearTimer();
    this.#queue = [];
    this.#results.clear();
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
      this.#settle(current.text, { status: 'error', message: 'took too long to compile' });
    this.#spawn();
  }
}

const isEmpty = (dagLines: readonly string[]): boolean =>
  dagLines.every((line) => line.trim() === '');
