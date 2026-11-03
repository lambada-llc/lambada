#!/usr/bin/env node
// Hold the editor's statement splitting to the compiler's.
//
//   node codemirror/scripts/statements-agree.mjs [file-or-directory...]
//
// The build compiles a source through the compiler's own `statements`; the
// editor splits a document itself, synchronously, on every keystroke, and
// compiles each piece. Where the two split differently, the editor compiles
// text the build never does — so this runs both over the same sources and fails
// on the first statement where they differ, in its text or in the code line it
// ends on, which is what an expect test is named and placed by.
//
// The compiler's side is `compiler/statements.dag`, exported by the build that
// owns the compiler, evaluated by the editor's own vendored evaluator. Code
// lines are counted by the build tool's `physical_lines`. The editor's side is
// `split`, imported as TypeScript — Node 22.18+ strips the types itself.
//
// Sources are the arguments, or this repository's examples; every run also
// covers the layouts in EDGES, which no source has to happen to contain.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeMachine } from '../src/runtime/machine.js';
import { split } from '../src/split.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const { is_lamb_file, physical_lines } = createRequire(import.meta.url)('../../bin/project.js');

const EDGES = {
  'comments, blanks and continuations': 'a = 1\n\n# prose\n  b\nc\n\td\n  # not prose\ne = f\n',
  'nothing': '',
  'an indented first line': '  x\ny\n',
  'a run of non-code inside a statement': 'a =\n  b\n# c\n\n  d\n\t\ne',
  'a line of spaces inside a string': 'x = "a\n  \n  b"\nx\n',
  'trailing whitespace': 'x = 1   \ny = x\t\n',
  'no final newline': 'x = 1\nx',
  'a comment that is code': 'x = 1\n #  not a comment line\n',
  'carriage returns': 'x = "a\r\nb"\r\nx\r\n',
};

// The editor's lines: `lambada()` sets CodeMirror's line separator to \n alone.
const editorLines = (text) => text.split('\n');

function compilerSide(machine, statements, text) {
  const { nodes, root } = machine.toNodes(machine.apply(statements, machine.ofString(text)));
  const kids = (i) => {
    const [l, r] = [nodes[2 * i], nodes[2 * i + 1]];
    return l < 0 ? [] : r < 0 ? [l] : [l, r];
  };
  const list = (i) => {
    const items = [];
    for (let k = kids(i); k.length === 2; k = kids(k[1])) items.push(k[0]);
    return items;
  };
  const nat = (i) => list(i).reduceRight((n, bit) => 2 * n + kids(bit).length, 0);
  const string = (i) => list(i).map((c) => String.fromCodePoint(nat(c))).join('');
  return list(root).map((pair) => {
    const [line, body] = kids(pair);
    return { line: nat(line), text: string(body) };
  });
}

function editorSide(text) {
  const lines = editorLines(text);
  const physical = physical_lines(text);
  const codeLine = new Map(physical.map((p, n) => [p, n]));
  return split(lines.length, (n) => lines[n - 1]).map(({ last, text }) => ({
    line: codeLine.get(last),
    text,
  }));
}

function sources(paths) {
  const found = [];
  const walk = (path) => {
    if (statSync(path).isDirectory()) for (const entry of readdirSync(path)) walk(join(path, entry));
    else if (is_lamb_file(path)) found.push(path);
  };
  paths.forEach((path) => walk(resolve(path)));
  return found.sort();
}

const machine = makeMachine();
const statements = machine.ofDag(readFileSync(join(repo, 'compiler/statements.dag'), 'utf8'));
const args = process.argv.slice(2);
const cases = [
  ...Object.entries(EDGES).map(([name, text]) => [`edge case: ${name}`, text]),
  ...sources(args.length ? args : [join(repo, 'examples')])
    .map((path) => [relative(process.cwd(), path), readFileSync(path, 'utf8')]),
];

let failed = 0;
for (const [name, text] of cases) {
  const compiler = compilerSide(machine, statements, text);
  const editor = editorSide(text);
  const at = compiler.findIndex((s, i) => s.line !== editor[i]?.line || s.text !== editor[i]?.text);
  const differ = at >= 0 ? at : compiler.length !== editor.length ? compiler.length : -1;
  if (differ < 0) continue;
  failed++;
  const show = (s) => (s ? `ends on code line ${s.line}: ${JSON.stringify(s.text).slice(0, 200)}` : 'nothing');
  console.error(`DIFFER ${name}, statement ${differ + 1}\n  compiler: ${show(compiler[differ])}\n  editor:   ${show(editor[differ])}`);
}
console.log(`${cases.length - failed} of ${cases.length} split alike`);
process.exit(failed ? 1 : 0);
