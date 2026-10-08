# Environment for running the backend locally against the dev containers.
# Source it, or let testbed/up.sh source it. Values match the backend's mise.toml.
SDK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SUBAKO_REPO_GIVEN="${SUBAKO_REPO:-$SDK_DIR/../../subako}"
if ! SUBAKO_REPO="$(cd "$SUBAKO_REPO_GIVEN" 2>/dev/null && pwd)"; then
	echo "error: no subako checkout at $SUBAKO_REPO_GIVEN; set SUBAKO_REPO to it" >&2
	return 1 2>/dev/null || exit 1
fi
export SUBAKO_REPO
export SUBAKO_CORE="$SUBAKO_REPO/target/debug/subako-core"
export SUBAKO_CLI="$SUBAKO_REPO/target/debug/subako"

export DATABASE_URL="postgres://subako:subako@localhost:5432/subako"
export AWS_ENDPOINT_URL="http://localhost:4566"
export AWS_REGION="us-east-1"
export AWS_ACCESS_KEY_ID="subako-dev-access-key"
export AWS_SECRET_ACCESS_KEY="subako-dev-secret-key"
export MOCK_OAUTH2_URL="http://127.0.0.1:8081"

export SUBAKO_DEPLOYMENT_ID="local"
export SUBAKO_CATALOG_URI="file://$SDK_DIR/testbed/catalog.yaml"
export SUBAKO_CATALOG_SHA256="$(sha256sum "$SDK_DIR/testbed/catalog.yaml" | cut -d' ' -f1)"
export SUBAKO_OIDC_CLIENT_SECRET="subako-dev-secret"
export SUBAKO_PUBLIC_BASE_URL="http://localhost:8080"
export SUBAKO_ALLOW_LOOPBACK="true"
export SUBAKO_CREDENTIAL_ENV="dev"
export SUBAKO_OBJECT_STORE_BUCKET="subako-dev"
export SUBAKO_ENGINE_HOST="127.0.0.1"
export SUBAKO_ENGINE_PORT="7801"
export SUBAKO_ENGINE_BASE_URL="http://127.0.0.1:7801"
export SUBAKO_CORE_WS="ws://127.0.0.1:7801/v1/engine/ws"
export MOCK_ANTHROPIC_PORT="9797"

export SUBAKO_TESTBED_ORG="dev"
export SUBAKO_TESTBED_EMAIL="dev@localhost.test"
export SUBAKO_CREDENTIALS_FILE="$SDK_DIR/testbed/.state/credentials.json"

# kumo keeps KMS keys in memory, so the key id is minted once per container life.
if [ -f "$SDK_DIR/testbed/.state/kms-key-id" ]; then
	export SUBAKO_KMS_KEY_ID="$(cat "$SDK_DIR/testbed/.state/kms-key-id")"
fi
