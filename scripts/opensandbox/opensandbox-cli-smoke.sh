#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_PATH="${ROOT_DIR}/.local/opensandbox/env.sh"

if [[ ! -f "${ENV_PATH}" ]]; then
  echo "OpenSandbox is not initialized yet. Run: bash ./scripts/opensandbox/opensandbox-init.sh" >&2
  exit 1
fi

source "${ENV_PATH}"

osb_cli() {
  HOME="${OR3_NET_OPENSANDBOX_CLI_HOME}" \
    "${OR3_NET_OPENSANDBOX_VENV}/bin/osb" \
    --domain "${SANDBOX_DOMAIN}" \
    --protocol http \
    --api-key "${SANDBOX_API_KEY}" \
    "$@"
}

wait_for_server() {
  local url="http://${SANDBOX_DOMAIN}/health"
  local attempts=0
  until curl -fsS "${url}" >/dev/null 2>&1; do
    attempts=$((attempts + 1))
    if [[ ${attempts} -ge 60 ]]; then
      echo "OpenSandbox server is not reachable at ${url}" >&2
      exit 1
    fi
    sleep 1
  done
}

extract_first_string_field() {
  local field_name="$1"
  local payload
  payload="$(cat)"
  PAYLOAD_JSON="${payload}" "${OR3_NET_OPENSANDBOX_VENV}/bin/python" - "$field_name" <<'PY'
import json
import os
import sys

field = sys.argv[1]
payload = json.loads(os.environ["PAYLOAD_JSON"])


def find(value):
    if isinstance(value, dict):
        if isinstance(value.get(field), str) and value[field]:
            return value[field]
        for nested in value.values():
            found = find(nested)
            if found:
                return found
    elif isinstance(value, list):
        for nested in value:
            found = find(nested)
            if found:
                return found
    return None

result = find(payload)
if result is None:
    raise SystemExit(f"missing field: {field}")
print(result, end="")
PY
}

wait_for_server
osb_cli config show >/dev/null

sandbox_json="$(osb_cli -o json sandbox create --image "${OR3_NET_OPENSANDBOX_DEFAULT_IMAGE}" --timeout 10m --ready-timeout "${OR3_NET_OPENSANDBOX_READY_TIMEOUT_SECONDS}s" --entrypoint '["tail","-f","/dev/null"]')"
sandbox_id="$(printf '%s' "${sandbox_json}" | extract_first_string_field id)"

cleanup() {
  if [[ -n "${sandbox_id:-}" ]]; then
    osb_cli sandbox kill "${sandbox_id}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

osb_cli sandbox list >/dev/null
osb_cli exec "${sandbox_id}" -- python -c 'print(2 + 2)' >/tmp/or3-net-opensandbox-cli-exec.log
osb_cli file mkdir "${sandbox_id}" /tmp/or3-cli-smoke >/dev/null
osb_cli file write "${sandbox_id}" /tmp/or3-cli-smoke/hello.txt -c 'hello from osb cli' >/dev/null
file_content="$(osb_cli file cat "${sandbox_id}" /tmp/or3-cli-smoke/hello.txt)"
if [[ "${file_content}" != "hello from osb cli" ]]; then
  echo "Unexpected CLI file content: ${file_content}" >&2
  exit 1
fi

osb_cli exec "${sandbox_id}" -- sh -lc 'nohup python -m http.server 8001 --directory /tmp/or3-cli-smoke >/tmp/or3-cli-http.log 2>&1 &' >/dev/null
sleep 2
endpoint_json="$(osb_cli -o json sandbox endpoint "${sandbox_id}" --port 8001)"
endpoint_url="$(printf '%s' "${endpoint_json}" | extract_first_string_field url 2>/dev/null || true)"
if [[ -z "${endpoint_url}" ]]; then
  endpoint_value="$(printf '%s' "${endpoint_json}" | extract_first_string_field endpoint)"
  endpoint_url="http://${endpoint_value}"
fi
curl -fsS "${endpoint_url}/hello.txt" | grep -q 'hello from osb cli'

osb_cli sandbox pause "${sandbox_id}" >/dev/null
osb_cli sandbox resume "${sandbox_id}" >/dev/null
osb_cli sandbox kill "${sandbox_id}" >/dev/null
sandbox_id=""
trap - EXIT

echo "OpenSandbox CLI smoke test passed."
