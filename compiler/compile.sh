#!/usr/bin/env bash

set -euo pipefail

# Usage: cat definitions.lamb | ./compile.sh expression > whatever.dag
#
# Compiles the definitions and the expression, links them, and writes the DAG
# of the expression's value. `lambada emit` does the compiling; the runtime's
# CLI does the linking, and is what runs the result afterwards.

here="$(dirname "$0")"
# Compiled chunks are memoized beside this script; the runtime is fetched there too.
emit() { node "$here/../bin/lambada.js" emit --cache "$here/.cache/lambada"; }
tc="$here/tree-calculus.js"
>&2 echo Downloading latest version of the Tree Calculus runtime...
tctmp=$(mktemp)
(curl --silent https://raw.githubusercontent.com/lambada-llc/tree-calculus/refs/heads/main/bin/main.js > "$tctmp" && mv "$tctmp" "$tc") ||
  (echo Failed. && test -f "$tc" && echo Found preexisting runtime, using that.) >&2

# The definitions' own bare expressions are dropped: a one-word line ends the
# document, and the expression asked for is what it should end on.
{ emit | grep ' '
  printf '%s\n' "$1" | emit
} | node "$tc" -dag -
