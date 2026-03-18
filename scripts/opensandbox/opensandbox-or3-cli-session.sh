#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BASE_URL="${OR3_NET_DEV_BASE_URL:-http://127.0.0.1:3001}"
WORKSPACE_ID="${OR3_NET_DEV_WORKSPACE_ID:-ws_demo}"
SESSION_DIR="${ROOT_DIR}/.local/opensandbox/or3-cli-session"
TOKEN_JSON="${SESSION_DIR}/token.json"
RUNTIMES_JSON="${SESSION_DIR}/runtimes.json"
CREATE_JSON="${SESSION_DIR}/runtime-session-create.json"
EXEC_JSON="${SESSION_DIR}/runtime-session-exec.json"
COPY_IN_JSON="${SESSION_DIR}/runtime-session-copy-in.json"
COPY_OUT_JSON="${SESSION_DIR}/runtime-session-copy-out.json"
LOGS_JSON="${SESSION_DIR}/runtime-session-logs.json"
DESTROY_JSON="${SESSION_DIR}/runtime-session-destroy.json"

mkdir -p "${SESSION_DIR}"

log_step() {
  printf '\n==> %s\n' "$1"
}

extract_json_field() {
  local json_path="$1"
  local expression="$2"
  python3 - "$json_path" "$expression" <<'PY'
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text())
expr = sys.argv[2]
value = payload
for part in expr.split('.'):
    value = value[part]
if isinstance(value, (dict, list)):
    print(json.dumps(value))
else:
    print(value)
PY
}

run_cli() {
  bun run cli -- "$@"
}

log_step "exchanging auth token"
run_cli auth exchange --base-url "${BASE_URL}" --workspace-id "${WORKSPACE_ID}" > "${TOKEN_JSON}"
cat "${TOKEN_JSON}"
TOKEN="$(extract_json_field "${TOKEN_JSON}" token)"

log_step "listing runtimes"
run_cli runtimes list --base-url "${BASE_URL}" --workspace-id "${WORKSPACE_ID}" --token "${TOKEN}" > "${RUNTIMES_JSON}"
cat "${RUNTIMES_JSON}"

log_step "creating runtime session"
run_cli runtime-sessions create \
  --base-url "${BASE_URL}" \
  --workspace-id "${WORKSPACE_ID}" \
  --token "${TOKEN}" \
  --runtime-id opensandbox \
  --input-json '{"workspace_mode":"none","required_capabilities":["exec","copy-in","copy-out"]}' \
  > "${CREATE_JSON}"
cat "${CREATE_JSON}"
SESSION_ID="$(extract_json_field "${CREATE_JSON}" session.session_id)"
printf 'session_id=%s\n' "${SESSION_ID}"

cleanup() {
  if [[ -n "${SESSION_ID:-}" ]]; then
    run_cli runtime-sessions destroy --base-url "${BASE_URL}" --workspace-id "${WORKSPACE_ID}" --session-id "${SESSION_ID}" --token "${TOKEN}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

log_step "executing command inside runtime session"
run_cli runtime-sessions exec \
  --base-url "${BASE_URL}" \
  --workspace-id "${WORKSPACE_ID}" \
  --session-id "${SESSION_ID}" \
  --token "${TOKEN}" \
  --command python \
  --args-json '["-c","print(\"hello from or3 cli\")"]' \
  > "${EXEC_JSON}"
cat "${EXEC_JSON}"

log_step "copying a file into the runtime session"
run_cli runtime-sessions copy-in \
  --base-url "${BASE_URL}" \
  --workspace-id "${WORKSPACE_ID}" \
  --session-id "${SESSION_ID}" \
  --token "${TOKEN}" \
  --destination-path /tmp/cli-demo.txt \
  --content-text 'hello from copy-in' \
  > "${COPY_IN_JSON}"
cat "${COPY_IN_JSON}"

log_step "copying the file back out"
run_cli runtime-sessions copy-out \
  --base-url "${BASE_URL}" \
  --workspace-id "${WORKSPACE_ID}" \
  --session-id "${SESSION_ID}" \
  --token "${TOKEN}" \
  --source-path /tmp/cli-demo.txt \
  --encoding text \
  > "${COPY_OUT_JSON}"
cat "${COPY_OUT_JSON}"

log_step "reading runtime logs"
run_cli runtime-sessions logs \
  --base-url "${BASE_URL}" \
  --workspace-id "${WORKSPACE_ID}" \
  --session-id "${SESSION_ID}" \
  --token "${TOKEN}" \
  --limit 20 \
  > "${LOGS_JSON}"
cat "${LOGS_JSON}"
grep -Eq '"chunks":[[:space:]]*\[' "${LOGS_JSON}"
if grep -Eq '"chunks":[[:space:]]*\[[[:space:]]*\]' "${LOGS_JSON}"; then
  echo "runtime logs were empty" >&2
  exit 1
fi

log_step "destroying runtime session"
run_cli runtime-sessions destroy \
  --base-url "${BASE_URL}" \
  --workspace-id "${WORKSPACE_ID}" \
  --session-id "${SESSION_ID}" \
  --token "${TOKEN}" \
  > "${DESTROY_JSON}"
cat "${DESTROY_JSON}"
SESSION_ID=""
trap - EXIT

log_step "OR3 Net runtime CLI manual session passed"
