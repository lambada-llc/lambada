#!/usr/bin/env bash

set -euo pipefail

# Uses compile_to_dag.dag to compile compiler.lamb into an updated compile_to_dag.dag and compile.dag 
result=$(mktemp)
cat "$(dirname "$0")/compiler.lamb" | "$(dirname "$0")/compile.sh" compile_to_dag > "$result"
mv "$result" "$(dirname "$0")/compile_to_dag.dag"
cat "$(dirname "$0")/compiler.lamb" | "$(dirname "$0")/compile.sh" compile > "$result"
mv "$result" "$(dirname "$0")/compile.dag"
