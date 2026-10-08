#!/usr/bin/env bash
# Fails if the committed generated clients drift from the documents in openapi/.
set -euo pipefail
cd "$(dirname "$0")/.."

pnpm run --silent gen

if ! git diff --exit-code packages/sdk/src/generated; then
    echo "error: generated client is stale; run 'pnpm run gen' and commit" >&2
    exit 1
fi
if [ -n "$(git ls-files --others --exclude-standard -- packages/sdk/src/generated)" ]; then
    echo "error: untracked generated files found; run 'pnpm run gen' and commit them" >&2
    exit 1
fi
