#!/usr/bin/env bash

set -euo pipefail

# Usage: cat definitions.lamb | ./compile.sh expression > whatever.dag

compiler="$(dirname "$0")/compiler.dag"
tc="$(dirname "$0")/tree-calculus.js"
>&2 echo Downloading latest version of the Tree Calculus runtime...
curl --silent https://raw.githubusercontent.com/lambada-llc/tree-calculus/refs/heads/main/bin/main.js > "$tc"

function compile_chunk {
  >&2 echo -n .
  node "$tc" -file -dag "$compiler" -string "$1"
}
export compiler
export tc
export -f compile_chunk

(
  >&2 echo -n Compiling chunks
  echo '__ENV△ △'
  perl -pe 's/^([^\s].*)$/\x0$1/' | parallel --null --keep-order compile_chunk | grep ' ';
  compile_chunk "$1"
  >&2 echo
  >&2 echo Linking...
) | node "$tc" -dag -

