// A tree calculus evaluator, the DAG text format, and the conversions between
// trees and JavaScript values.
//
// Copied, not depended on, and left as JavaScript: annotating it would make
// every update from upstream a merge. `machine.d.ts` beside it states what it
// offers, and is what the worker is checked against. Taken from
// https://github.com/lambada-llc/tree-calculus (MIT), where the originals are
// `implementation/typescript/src/common.mjs`, `format/dag.mjs` and
// `evaluator/lazy-stacks-opt.mjs`.

// --- evaluator: lazy, with an explicit stack ------------------------------
// `apply` costs nothing — it conses. Everything happens in `triage`, which
// forces, which is why a runaway program can only be stopped by killing the
// thread it runs on.
//
// A step whose operand is not yet a value cannot proceed, so it pushes its
// three operands back, puts that operand on the work stack, and runs again once
// it has been forced. Re-running costs three pops and a length test, and can
// happen at most once per force, because forcing leaves the operand a value.
// Hence the step count sits at each rewrite rather than at the top of the loop:
// a re-run is not a reduction.
//
// The pushes are written out per length rather than spread. Forcing reduces a
// node to a value, so every operand pushed here holds at most two arguments,
// and a spread costs a variadic call where a fixed-arity push does not. The
// exception is rule 2's `y`, which is not forced, so its common lengths are
// unrolled and the general case kept.

function force_root(root) {
  const work = [root];
  outer: while (work.length > 0) {
    const s = work[work.length - 1];
    while (s.length >= 3) {
      const x = s.pop(),
        y = s.pop(),
        z = s.pop();
      if (x.length > 2) {
        s.push(z, y, x);
        work.push(x);
        continue outer;
      }
      if (x.length === 0) {
        // leaf
        if (y.length > 2) {
          s.push(z, y, x);
          work.push(y);
          continue outer;
        }
        steps.count++;
        if (y.length === 1) s.push(y[0]);
        else if (y.length === 2) s.push(y[0], y[1]);
      } else if (x.length === 1) {
        const u = x[0];
        if (u.length > 2) {
          s.push(z, y, x);
          work.push(u);
          continue outer;
        }
        steps.count++;
        // [z, ...y] is tricky:
        // - if y is unreduced and we don't force it, we may end up reducing it multiple times
        // - if y is unreduced and we force it, it might end up getting dropped
        const yz =
          y.length === 0
            ? [z]
            : y.length === 1
              ? [z, y[0]]
              : y.length === 2
                ? [z, y[0], y[1]]
                : [z, ...y];
        if (u.length === 0) s.push(yz, z);
        else if (u.length === 1) s.push(yz, z, u[0]);
        else s.push(yz, z, u[0], u[1]);
      } else {
        // fork
        if (z.length > 2) {
          s.push(z, y, x);
          work.push(z);
          continue outer;
        }
        if (z.length === 0) {
          // leaf
          const v = x[1];
          if (v.length > 2) {
            s.push(z, y, x);
            work.push(v);
            continue outer;
          }
          steps.count++;
          if (v.length === 1) s.push(v[0]);
          else if (v.length === 2) s.push(v[0], v[1]);
        } else if (z.length === 1) {
          // stem
          const u = x[0];
          if (u.length > 2) {
            s.push(z, y, x);
            work.push(u);
            continue outer;
          }
          steps.count++;
          if (u.length === 0) s.push(z[0]);
          else if (u.length === 1) s.push(z[0], u[0]);
          else s.push(z[0], u[0], u[1]);
        } else {
          // fork
          if (y.length > 2) {
            s.push(z, y, x);
            work.push(y);
            continue outer;
          }
          steps.count++;
          if (y.length === 0) s.push(z[0], z[1]);
          else if (y.length === 1) s.push(z[0], z[1], y[0]);
          else s.push(z[0], z[1], y[0], y[1]);
        }
      }
    }
    work.pop();
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

// --- a value as a flat DAG -------------------------------------------------
// Two slots per node holding the indices of its children, -1 where it has
// none, and children before parents. Flat because the structured clone that
// carries a message out of a worker recurses over what it copies: a value
// nests as deep as a string is long, and a couple of thousand characters is
// enough to overflow the stack a worker gets. Sharing survives too — a subtree
// reached twice is one index either way.

function nodesOf(e, x) {
  const index = new Map();
  const nodes = [];
  // An explicit stack, for the same reason the format is flat.
  const todo = [x];
  while (todo.length) {
    const node = todo[todo.length - 1];
    if (index.has(node)) {
      todo.pop();
      continue;
    }
    const cs = children(e, node);
    const missing = cs.filter((c) => !index.has(c));
    if (missing.length) {
      todo.push(...missing);
      continue;
    }
    index.set(node, nodes.length / 2);
    nodes.push(cs.length > 0 ? index.get(cs[0]) : -1, cs.length > 1 ? index.get(cs[1]) : -1);
    todo.pop();
  }
  return { nodes, root: index.get(x) };
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
        .map((x) => {
          const code = Number(x);
          // Only what is a character at all. Control characters stay in: what
          // the compiler hands back is itself a string, and its lines are
          // separated by one.
          if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff))
            throw new Error('not a character');
          return String.fromCodePoint(code);
        })
        .join(''),
    of_string: (s) => of_list(Array.from(s).map((c) => of_nat(BigInt(c.codePointAt(0))))),
  };
}

// --- what the rest of the package uses -------------------------------------
// Deliberately few, and none of them a triage: forcing a tree is what can fail
// to finish, and it happens here rather than anywhere that could be holding a
// document open.

function makeMachine() {
  const m = makeMarshal(evaluator);
  return {
    ofDag: (text) => dagOf(evaluator, text.trimEnd()),
    toNodes: (tree) => nodesOf(evaluator, tree),
    ofString: (s) => m.of_string(s),
    toString: (tree) => m.to_string(tree),
    apply: (f, x) => evaluator.apply(f, x),
    steps,
  };
}

export { makeMachine };
