#!/usr/bin/env bash

set -euo pipefail

# Usage: cat definitions.lamb | ./compile.sh expression > whatever.dag
#
# Compiles the definitions and the expression, links them, and writes the DAG
# of the expression's value. `lambada emit` does the compiling; the runtime's
# CLI does the linking, and is what runs the result afterwards. Both use the
# runtime revision tree-calculus-revision names, or $LAMBADA_TREE_CALCULUS.

here="$(dirname "$0")"
# Compiled sources are kept beside this script, unless the caller keeps them
# elsewhere; the runtime is fetched there too.
emit() { TREE_CALCULUS_CACHE="${TREE_CALCULUS_CACHE:-$here/.cache/tree-calculus}" node "$here/../bin/lambada.js" emit; }
# The runtime's CLI, kept beside this script, where what it writes is run from.
tc="$here/tree-calculus.js"
cp "$(node "$here/../bin/runtime.js" main.js)" "$tc"

# The definitions' own bare expressions are dropped: a one-word line ends the
# document, and the expression asked for is what it should end on.
{ emit | grep ' '
  printf '%s\n' "$1" | emit
} | node "$tc" -dag -
