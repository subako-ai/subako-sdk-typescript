#!/usr/bin/env bash
# Runs one example against the Subako deployment the CLI is signed in to: the
# credentials, the packages, the example's own server, and Vite, all in the
# foreground with both logs on this terminal. Ctrl-C stops the two of them.
#
#   pnpm example chat                            then open http://localhost:5173
#   pnpm example todo
#   SUBAKO_PROFILE=my-staging pnpm example todo  one CLI profile by name
#   EXAMPLE_WEB_PORT=5180 pnpm example todo      when 5173 is taken
set -euo pipefail
cd "$(dirname "$0")/.."
STATE=testbed/.state

examples=()
for directory in examples/*/; do
	[ -f "$directory/package.json" ] && examples+=("$(basename "$directory")")
done
name="${1:-}"
if [ -z "$name" ] || [ ! -f "examples/$name/package.json" ]; then
	echo "usage: pnpm example <name>; the examples are: ${examples[*]}" >&2
	exit 1
fi

export EXAMPLE_PORT="${EXAMPLE_PORT:-9800}"
export EXAMPLE_WEB_PORT="${EXAMPLE_WEB_PORT:-5173}"

testbed/cloud.sh

echo "== packages"
pnpm run build

# The page reaches the backend directly; CORS for this origin is set by the example's server.
export VITE_SUBAKO_BASE_URL="${VITE_SUBAKO_BASE_URL:-$(sed -n 's/^SUBAKO_BASE_URL=//p' "$STATE/sdk.env")}"

echo "== $name on http://localhost:$EXAMPLE_WEB_PORT, its server on http://127.0.0.1:$EXAMPLE_PORT"

# The trap goes up before anything is started, so a Ctrl-C between the two still stops the first.
server=""
vite=""
trap 'kill "$server" "$vite" 2>/dev/null || true; rm -f "$STATE/example-server.pid" "$STATE/vite.pid"' EXIT INT TERM

node "examples/$name/server.mjs" &
server=$!
echo "$server" > "$STATE/example-server.pid"
(cd "examples/$name" && exec node_modules/.bin/vite) &
vite=$!
echo "$vite" > "$STATE/vite.pid"

wait -n "$server" "$vite"
