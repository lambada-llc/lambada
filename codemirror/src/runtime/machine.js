// A tree calculus evaluator, the DAG text format, and the conversions between
// trees and JavaScript values.
//
// Copied, not depended on: this file is concatenated verbatim into the worker
// source, and anything with an `import` in it could not be. Taken from
// https://github.com/lambada-llc/tree-calculus (MIT), where the originals are
// `implementation/typescript/src/common.mjs`, `format/dag.mjs` and
// `evaluator/lazy-stacks.mjs`.

// --- evaluator: lazy, with an explicit stack ------------------------------
// `apply` costs nothing — it conses. Everything happens in `triage`, which
// forces, which is why a runaway program can only be stopped by killing the
// thread it runs on.

const reduce_one = function* (s) {
  while (s.length >= 3) {
    steps.count++;
    const x = s.pop(),
      y = s.pop(),
      z = s.pop();
    if (x.length > 2) yield x;
    if (x.length === 0) {
      if (y.length > 2) yield y;
      s.push(...y); // leaf
    } else if (x.length === 1) {
      if (x[0].length > 2) yield x[0];
      s.push([z, ...y], z, ...x[0]);
    } else if (x.length === 2) {
      // fork
      if (z.length > 2) yield z;
      if (z.length === 0) {
        if (x[1].length > 2) yield x[1];
        s.push(...x[1]);
      } else if (z.length === 1) {
        if (x[0].length > 2) yield x[0];
        s.push(z[0], ...x[0]);
      } else if (z.length === 2) {
        if (y.length > 2) yield y;
        s.push(z[0], z[1], ...y);
      }
    }
  }
};

function force_root(expression) {
  const force = [reduce_one(expression)];
  while (force.length > 0) {
    const next = force[force.length - 1].next();
    if (next.done) force.pop();
    else force.push(reduce_one(next.value));
  }
}

const steps = { count: 0 };

const evaluator = {
  leaf: [],
  stem: (u) => [u],
  fork: (u, v) => [v, u],
  apply: (a, b) => [b, ...a],
  triage: (on_leaf, on_stem, on_fork) => (x) => {
    force_root(x);
    switch (x.length) {
      case 0:
        return on_leaf();
      case 1:
        return on_stem(x[0]);
      case 2:
        return on_fork(x[1], x[0]);
      default:
        throw new Error('not a value/binary tree');
    }
  },
};

const raise = (message) => {
  throw new Error(message);
};

const children = (e, x) =>
  e.triage(
    () => [],
    (u) => [u],
    (u, v) => [u, v],
  )(x);

// --- the DAG text format --------------------------------------------------
// `a b c` reads as "let a = b c in", `a b` as "let a = b in", and a bare `a`
// terminates the document, naming its value.

function dagOf(e, s) {
  const env = { '△': e.leaf };
  const get = (name) => (name in env ? env[name] : raise(`unbound variable: ${name}`));
  for (const line of s.split(/\r?\n/)) {
    const [a, b, c] = line.split(' ');
    if (c) env[a] = e.apply(get(b), get(c));
    else if (b) env[a] = get(b);
    else if (a) return get(a);
  }
  return raise('dag representation was unexpectedly not terminated by a value');
}

function dagTo(e, x) {
  const res = [];
  let i = 0;
  const app_keys = {};
  const apply_keys = (a, b) => {
    const app_key = `${a} ${b}`;
    const alloc = () => {
      const k = `${i++}`;
      res.push(`${k} ${app_key}`);
      return k;
    };
    return app_keys[app_key] ?? (app_keys[app_key] = alloc());
  };
  const keys = new Map();
  const todo = [{ node: x, enter: true }];
  while (todo.length) {
    const { node, enter } = todo.pop();
    if (keys.has(node)) continue;
    if (enter) {
      todo.push({ node, enter: false });
      for (const c of children(e, node)) todo.push({ node: c, enter: true });
    } else {
      let current = '△';
      for (const c of children(e, node)) current = apply_keys(current, keys.get(c));
      keys.set(node, current);
    }
  }
  res.push(keys.get(x));
  return res.join('\n');
}

// --- trees to and from JavaScript ------------------------------------------
// A string is a list of naturals, a natural is a list of bools (least
// significant first), and a list is nested forks ending in a leaf.

function makeMarshal(e) {
  const t_false = e.leaf;
  const t_true = e.stem(e.leaf);
  const to_bool = e.triage(
    () => false,
    () => true,
    () => raise('tree is not a bool'),
  );
  const of_bool = (b) => (b ? t_true : t_false);
  const to_list = (t) => {
    const l = [];
    const triage = e.triage(
      () => false,
      () => raise('tree is not a list'),
      (hd, tl) => (l.push(hd), (t = tl), true),
    );
    while (triage(t));
    return l;
  };
  const of_list = (l) => {
    let f = e.leaf;
    for (let i = l.length; i; i--) f = e.fork(l[i - 1], f);
    return f;
  };
  const to_nat = (t) =>
    to_list(t).reduceRight((acc, b) => 2n * acc + (to_bool(b) ? 1n : 0n), 0n);
  const of_nat = (n) => {
    const l = [];
    for (; n; n >>= 1n) l.push(of_bool(n % 2n == 1n));
    return of_list(l);
  };
  return {
    to_string: (t) =>
      to_list(t)
        .map(to_nat)
        .map((x) => String.fromCodePoint(Number(x)))
        .join(''),
    of_string: (s) => of_list(Array.from(s).map((c) => of_nat(BigInt(c.codePointAt(0))))),
  };
}

// --- what the rest of the package uses -------------------------------------
// Deliberately five verbs at DAG level. Nothing above ever triages a tree.

function makeMachine() {
  const m = makeMarshal(evaluator);
  return {
    ofDag: (text) => dagOf(evaluator, text.trimEnd()),
    toDag: (tree) => dagTo(evaluator, tree),
    ofString: (s) => m.of_string(s),
    toString: (tree) => m.to_string(tree),
    apply: (f, x) => evaluator.apply(f, x),
    steps,
  };
}
