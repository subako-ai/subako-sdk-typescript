#!/usr/bin/env bash
# Copies Core's public OpenAPI document into openapi/public.json, the source
# every generated artifact in this repo derives from.
#
# Source repo: $SUBAKO_REPO if set, else the Subako repository this directory
# sits in.
set -euo pipefail
cd "$(dirname "$0")/.."

repo="${SUBAKO_REPO:-../..}"
mkdir -p openapi
for pair in core-server/openapi/public.json:public.json; do
    src="$repo/crates/${pair%%:*}"
    dst="openapi/${pair##*:}"
    if [ ! -f "$src" ]; then
        echo "error: OpenAPI document not found at $src" >&2
        echo "hint: set SUBAKO_REPO to the subako checkout, e.g. SUBAKO_REPO=~/projects/subako $0" >&2
        exit 1
    fi
    cp "$src" "$dst"
    echo "synced $src -> $dst"
done
