#!/usr/bin/env bash
# Prepares the SDK's credentials against a Subako deployment the CLI is already
# signed in to, and writes them where the demo server reads them. Idempotent:
# it mints nothing when testbed/.state/sdk.env is already there.
#
#   testbed/cloud.sh                                  the current CLI profile
#   SUBAKO_PROFILE=my-staging testbed/cloud.sh        one profile by name
#   SUBAKO_CLI=~/Downloads/subako-test/subako testbed/cloud.sh
#
# The CLI reads its server from the profile, not from the environment: `subako
# profile list` is what says which deployment a profile is signed in to.
set -euo pipefail
cd "$(dirname "$0")/.."
STATE=testbed/.state
mkdir -p "$STATE"

CLI="${SUBAKO_CLI:-subako}"
AGENT_CONFIG="${SUBAKO_AGENT_CONFIG:-testbed/agent.json}"
command -v "$CLI" >/dev/null 2>&1 || [ -x "$CLI" ] || {
	echo "error: no subako CLI at '$CLI'; set SUBAKO_CLI to the binary" >&2
	exit 1
}

# `--profile` is accepted by every command below; an empty PROFILE means the current one.
profile_args=()
if [ -n "${SUBAKO_PROFILE:-}" ]; then
	profile_args=(--profile "$SUBAKO_PROFILE")
fi

who="$("$CLI" whoami "${profile_args[@]}" 2>&1)" || {
	echo "error: the CLI is not signed in${SUBAKO_PROFILE:+ on profile $SUBAKO_PROFILE}; run: $CLI login" >&2
	echo "$who" >&2
	exit 1
}
name="$(printf '%s\n' "$who" | sed -n 's/^profile: //p')"
workspace="$(printf '%s\n' "$who" | sed -n 's/^workspace: .*(\(.*\))$/\1/p')"
[ -n "$workspace" ] || {
	echo "error: profile $name has no workspace selected; run: $CLI workspace use <id>" >&2
	exit 1
}
# The row for this profile carries the deployment it is signed in to.
base="$("$CLI" profile list 2>/dev/null | awk -v p="$name" '$0 ~ ("(^| )" p " ") { for (i = 1; i <= NF; i++) if ($i ~ /^server=/) { sub(/^server=/, "", $i); print $i; exit } }')"
[ -n "$base" ] || { echo "error: could not read the server of profile $name" >&2; exit 1; }

echo "== profile $name on $base (workspace $workspace)"

if [ ! -f "$STATE/sdk.env" ]; then
	echo "== api key"
	minted="$("$CLI" api-key mint --label "sdk testbed demo" --all-permissions "${profile_args[@]}")"
	secret="$(printf '%s\n' "$minted" | awk '/shown once/{getline; print; exit}' | tr -d '[:space:]')"
	case "$secret" in
		sbk_ak_*) ;;
		*) echo "error: could not read the minted secret out of the CLI's output" >&2; exit 1;;
	esac
	umask 077
	printf 'SUBAKO_BASE_URL=%s\nSUBAKO_API_KEY=%s\nSUBAKO_WORKSPACE_ID=%s\n' \
		"$base" "$secret" "$workspace" > "$STATE/sdk.env"
	echo "   wrote $STATE/sdk.env"
else
	echo "== api key: $STATE/sdk.env is already there (delete it to mint another)"
fi

cp "$AGENT_CONFIG" "$STATE/agent-config.json"
echo "== agent config from $AGENT_CONFIG"
echo
echo "ready: an example's server reads $STATE/sdk.env; try: pnpm example chat"
