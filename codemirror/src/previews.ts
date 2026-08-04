import {
  RangeSetBuilder,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';

import { analyze } from './analysis';
import { Compiler, type Evaluation, type Value } from './compile';
import { lambadaCompilations, type CompileConfig } from './compilation';
import { defaultCompiler } from './generated/compiler';

/** A statement that is an expression, and the whole program that produces it. */
interface Expression {
  from: number;
  to: number;
  /** Everything above it, plus itself: a document the runtime can evaluate. */
  dag: string;
}

// The compiler emits references to `__ENV△` and expects it to be the leaf.
// Nothing in the DAG format binds it, so anything evaluated has to say so.
const leafBinding = '__ENV△ △';

const isBare = (line: string) => line.trim().split(' ').length === 1;

/**
 * The statements that are expressions rather than definitions, each with the
 * program that evaluates it.
 *
 * The compiler ends what it produces with a bare name when the source was an
 * expression, and with nothing when it was a definition — which is how the two
 * are told apart. Carrying an expression forward means dropping that bare name
 * again, since it would end the document before the statements below it.
 */
export function expressionsIn(
  state: EditorState,
  environment: string,
): readonly Expression[] {
  const context: string[] = [leafBinding];
  if (environment.trim()) context.push(environment.trim());
  const found: Expression[] = [];

  for (const { statement, state: status } of analyze(state, environment)) {
    if (status !== 'ok') {
      // Nothing below a statement that did not compile can be evaluated
      // either: its definitions are missing from everything that follows.
      if (status !== 'blocked') break;
      continue;
    }
    const compilation = state.field(lambadaCompilations).get(statement.text);
    if (compilation?.status !== 'ok') continue;
    const lines = compilation.dagLines.filter((line) => line.trim());
    const bare = lines.filter(isBare);
    if (bare.length)
      found.push({
        from: statement.from,
        to: statement.to,
        dag: context.concat(lines).join('\n'),
      });
    context.push(...lines.filter((line) => !isBare(line)));
  }
  return found;
}

/**
 * How a value is worth showing. A value can read as several of these at once —
 * the leaf is the empty string, zero and false together — so the order is what
 * decides, and the most particular reading wins.
 */
export function describe(value: Value): string {
  if (value.text) return JSON.stringify(value.text);
  // The leaf is the empty string, zero and false at once. `false` is the
  // reading a program most often meant, and the one worth leading with.
  if (value.bool !== undefined) return String(value.bool);
  if (value.nat !== undefined) return value.nat;
  return `${value.dagLines.filter((l) => l.trim()).length} nodes`;
}

const setEvaluations = StateEffect.define<ReadonlyMap<string, Evaluation>>();

const evaluations = StateField.define<ReadonlyMap<string, Evaluation>>({
  create: () => new Map(),
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setEvaluations)) return effect.value;
    return value;
  },
});

class PreviewWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }

  eq(other: PreviewWidget): boolean {
    return other.text === this.text;
  }

  toDOM(): HTMLElement {
    // A span, so it sits at the end of the line the expression is on rather
    // than pushing itself onto one of its own.
    const wrap = document.createElement('span');
    wrap.className = 'cm-preview';
    wrap.setAttribute('aria-hidden', 'true');
    wrap.textContent = this.text;
    return wrap;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

const theme = EditorView.baseTheme({
  '.cm-preview': {
    paddingLeft: '2ch',
    opacity: '0.6',
    fontStyle: 'italic',
    // It is not part of the document, so it must not look selectable or
    // land in a copy of the text.
    userSelect: 'none',
  },
});

const previewDecorations = (environment: string) =>
  StateField.define<DecorationSet>({
    create: (state) => build(state, environment),
    update: (value, tr) =>
      tr.docChanged || tr.effects.length ? build(tr.state, environment) : value,
    provide: (field) => EditorView.decorations.from(field),
  });

function build(state: EditorState, environment: string): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const known = state.field(evaluations);
  for (const expression of expressionsIn(state, environment)) {
    const evaluation = known.get(expression.dag);
    if (evaluation?.status !== 'ok') continue;
    builder.add(
      expression.to,
      expression.to,
      Decoration.widget({
        side: 1,
        widget: new PreviewWidget(`= ${describe(evaluation)}`),
      }),
    );
  }
  return builder.finish();
}

export function previews(
  environment: string,
  { compiler = defaultCompiler, timeout = 10000 }: CompileConfig,
): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      runner: Compiler<Value>;
      queued = false;
      dead = false;

      constructor(readonly view: EditorView) {
        // A worker of its own. Evaluating is unbounded, and a program that
        // will not finish must not hold up the compilations that mark the
        // document and feed the completions.
        this.runner = new Compiler<Value>(compiler, timeout, () => this.schedule(), 'run');
        this.sync();
      }

      update(update: ViewUpdate) {
        if (update.docChanged || update.transactions.some((tr) => tr.effects.length))
          this.sync();
      }

      sync() {
        const wanted = new Set(
          expressionsIn(this.view.state, environment).map((e) => e.dag),
        );
        this.runner.retain(wanted);
        for (const dag of wanted) this.runner.request(dag);
        this.schedule();
      }

      // As with compilations: never dispatch from inside an update.
      schedule() {
        if (this.queued || this.dead) return;
        this.queued = true;
        setTimeout(() => {
          this.queued = false;
          if (!this.dead) this.publish();
        }, 0);
      }

      publish() {
        const next = new Map<string, Evaluation>();
        for (const { dag } of expressionsIn(this.view.state, environment)) {
          const value = this.runner.get(dag);
          if (value) next.set(dag, value);
        }
        if (same(next, this.view.state.field(evaluations))) return;
        this.view.dispatch({ effects: setEvaluations.of(next) });
      }

      destroy() {
        this.dead = true;
        this.runner.destroy();
      }
    },
  );

  return [theme, evaluations, previewDecorations(environment), plugin];
}

function same(
  a: ReadonlyMap<string, Evaluation>,
  b: ReadonlyMap<string, Evaluation>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    const other = b.get(key);
    if (!other || other.status !== value.status) return false;
  }
  return true;
}
