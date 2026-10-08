#!/usr/bin/env bash
# Brings up the backend locally against a mock model and prepares an API key,
# workspace, and published agent for the SDK. Idempotent: rerun after a crash.
#
#   testbed/up.sh            start or resume the stack
#   testbed/up.sh --reset    drop the database and start over
set -euo pipefail
cd "$(dirname "$0")/.."
source testbed/env.sh
STATE=testbed/.state
mkdir -p "$STATE"

psql() { docker exec subako-postgres-1 psql -U subako -d subako -tAc "$1"; }
listening() { ss -ltn 2>/dev/null | grep -qE ":$1\b"; }
start() { # name, log, command...
	local name="$1" log="$2"; shift 2
	# No subshell, so `$!` is the process itself; setsid makes it the session leader down.sh stops.
	setsid nohup "$@" > "$log" 2>&1 &
	echo $! > "$STATE/$name.pid"
}
core_cli() { (cd "$SUBAKO_REPO" && "$@"); }

if [ "${1:-}" = "--reset" ]; then
	testbed/down.sh --reset
fi

echo "== containers"
docker compose -f "$SUBAKO_REPO/docker-compose.dev.yml" up -d --wait >/dev/null

echo "== binaries"
if [ ! -x "$SUBAKO_CORE" ] || [ ! -x "$SUBAKO_CLI" ]; then
	(cd "$SUBAKO_REPO" && cargo build --bin subako-core --bin subako)
fi

echo "== kms key"
if [ -n "${SUBAKO_KMS_KEY_ID:-}" ] && ! aws kms describe-key --key-id "$SUBAKO_KMS_KEY_ID" >/dev/null 2>&1; then
	echo "kumo no longer holds the KMS key; run testbed/up.sh --reset" >&2
	exit 1
fi
if [ -z "${SUBAKO_KMS_KEY_ID:-}" ]; then
	aws kms create-key --query KeyMetadata.KeyId --output text > "$STATE/kms-key-id"
	export SUBAKO_KMS_KEY_ID="$(cat "$STATE/kms-key-id")"
fi

echo "== release"
core_cli "$SUBAKO_CORE" release

echo "== organization"
if [ "$(psql "select count(*) from organizations where handle='$SUBAKO_TESTBED_ORG'")" = "0" ]; then
	provider="$(psql "select id from oidc_providers order by created_at desc limit 1")"
	core_cli "$SUBAKO_CORE" org create --handle "$SUBAKO_TESTBED_ORG" --name "Local Dev" --oidc-provider "$provider" >/dev/null
	core_cli "$SUBAKO_CORE" org invite --org "$SUBAKO_TESTBED_ORG" --email "$SUBAKO_TESTBED_EMAIL" --role admin >/dev/null
	core_cli "$SUBAKO_CORE" org deposit --org "$SUBAKO_TESTBED_ORG" --sc 1000 --external-ref local-seed >/dev/null
fi
if ! core_cli "$SUBAKO_CORE" model-provider list | grep -q '^anthropic'; then
	SUBAKO_MODEL_PROVIDER_API_KEY=mock core_cli "$SUBAKO_CORE" model-provider create \
		--slug anthropic --display-name "Mock Anthropic" --format anthropic \
		--base-url "http://127.0.0.1:$MOCK_ANTHROPIC_PORT" >/dev/null
fi

echo "== processes"
listening 8080 || start core "$STATE/core.log" env -C "$SUBAKO_REPO" "$SUBAKO_CORE" serve
listening "$MOCK_ANTHROPIC_PORT" || start mock "$STATE/mock.log" node testbed/mock-anthropic.mjs
if ! pgrep -f "[v]ite-node scripts/pool.ts" >/dev/null; then
	start engine "$STATE/engine.log" env -C "$SUBAKO_REPO" mise x -- pnpm --dir apps/engine-pi run pool
fi
for _ in $(seq 1 60); do curl -sf http://localhost:8080/health >/dev/null && break; sleep 0.5; done
curl -sf http://localhost:8080/health >/dev/null || { echo "core did not answer /health; see $STATE/core.log" >&2; exit 1; }
for _ in $(seq 1 60); do grep -q "pool: ready" "$STATE/engine.log" 2>/dev/null && break; sleep 0.5; done
grep -q "pool: ready" "$STATE/engine.log" || { echo "engine pool did not report ready; see $STATE/engine.log" >&2; exit 1; }

echo "== login"
if ! "$SUBAKO_CLI" whoami >/dev/null 2>&1; then
	node testbed/login.mjs "$SUBAKO_CLI" "$SUBAKO_TESTBED_ORG" "$SUBAKO_TESTBED_EMAIL" "$SUBAKO_CREDENTIALS_FILE" >/dev/null
fi

echo "== workspace, agent, api key"
if [ ! -f "$STATE/sdk.env" ]; then
	workspace="$("$SUBAKO_CLI" workspace list | grep -oE '^ *[0-9a-f-]{36}' | tr -d ' ' | head -1)"
	if [ -z "$workspace" ]; then
		workspace="$("$SUBAKO_CLI" workspace create --name dev | grep -oE '[0-9a-f-]{36}' | head -1)"
	fi
	"$SUBAKO_CLI" workspace use "$workspace" >/dev/null
	provider="$("$SUBAKO_CLI" model-provider list | grep 'owner=platform' | grep -oE '^[0-9a-f-]{36}' | head -1)"
	agent="$("$SUBAKO_CLI" agent create --name dev-assistant | grep -oE '[0-9a-f-]{36}' | head -1)"
	cat > "$STATE/agent-config.json" <<'JSON'
{
  "model": { "format": "anthropic", "model": "claude-sonnet-4-5-20250929", "max_tokens": 1024, "context_window": 200000 },
  "system_prompt": "You are a local development assistant. Prefer the client tools you are given."
}
JSON
	"$SUBAKO_CLI" agent publish "$agent" --config "$STATE/agent-config.json" --model-provider "$provider" >/dev/null
	secret="$("$SUBAKO_CLI" api-key mint --label "local sdk" --all-permissions | grep -oE 'sbk_ak_[A-Za-z0-9_-]+' | tail -1)"
	umask 077
	printf 'SUBAKO_BASE_URL=%s\nSUBAKO_API_KEY=%s\nSUBAKO_WORKSPACE_ID=%s\nSUBAKO_AGENT_ID=%s\n' \
		"$SUBAKO_PUBLIC_BASE_URL" "$secret" "$workspace" "$agent" > "$STATE/sdk.env"
fi

echo
echo "ready: core http://localhost:8080, engine wire :7801, mock model :$MOCK_ANTHROPIC_PORT"
echo "credentials for the SDK are in $STATE/sdk.env; try: pnpm build && node testbed/smoke.mjs"
