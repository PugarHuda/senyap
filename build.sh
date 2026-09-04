#!/usr/bin/env bash
# Compile the Senyap contract. Run from WSL: bash build.sh
set -uo pipefail
export PATH="$HOME/.local/bin:$PATH"
cd "$(dirname "$0")"
rm -rf src/managed
compact compile src/senyap.compact src/managed/senyap
