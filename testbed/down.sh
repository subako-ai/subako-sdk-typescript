#!/usr/bin/env bash
# Stops what testbed/example.sh started: the example's own server and Vite.
# `--forget` also drops testbed/.state, so the next run mints fresh credentials.
set -euo pipefail
cd "$(dirname "$0")/.."
STATE=testbed/.state

stop() { # name
	local file="$STATE/$1.pid" pid
	# Stopping the server ends the launcher, whose trap removes both files; a file gone by now has nothing to stop.
	pid="$(cat "$file" 2>/dev/null)" || return 0
	pkill -TERM -s "$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
	rm -f "$file"
}

for name in example-server vite; do
	stop "$name"
done

# The fallback, for a process started before its pid file existed: the server by
# its command line, which no shell running this matches, and either by the port
# it holds, which is what "still running" means to the person.
pkill -f "node .*[e]xamples/[^/]*/server.mjs" 2>/dev/null || true
for port in "${EXAMPLE_PORT:-9800}" "${EXAMPLE_WEB_PORT:-5173}"; do
	for pid in $(lsof -t -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null); do
		kill -TERM "$pid" 2>/dev/null || true
	done
done

if [ "${1:-}" = "--forget" ]; then
	rm -rf "$STATE"
	echo "forgot: testbed/.state cleared; the api key it held is still live until you revoke it"
fi
echo "stopped"
