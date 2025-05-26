#!/usr/bin/env bash

set -euo pipefail

# Uses compiler.dag to compile compiler.lamb into an updated compiler.dag
result=$(mktemp)
cat "$(dirname "$0")/compiler.lamb" | "$(dirname "$0")/compile.sh" compile_to_dag > "$result"
mv "$result" "$(dirname "$0")/compiler.dag"
