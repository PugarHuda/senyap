#!/usr/bin/env bash
# Compile the Senyap contract. Run from WSL: bash build.sh
set -uo pipefail
export PATH="$HOME/.local/bin:$PATH"
cd "$(dirname "$0")"
rm -rf src/managed
# Pinned to the ledger-v8 toolchain on purpose. 0.34.0 compiles this contract
# unchanged, but it emits runtime 0.19 / onchain-runtime-v4 / ledger-v9, and the
# only midnight-js that speaks v4 is a beta whose wallet SDK is canary-only.
# 0.31.1 emits runtime 0.16, which the stable deploy path wants.
compact update 0.31.1 >/dev/null 2>&1
compact compile src/senyap.compact src/managed/senyap
