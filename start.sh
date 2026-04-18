#!/usr/bin/env bash
set -euo pipefail

# Source .env if it exists
if [[ -f .env ]]; then
  set -a
  source .env
  set +a
fi

exec node --import tsx/esm src/index.ts
