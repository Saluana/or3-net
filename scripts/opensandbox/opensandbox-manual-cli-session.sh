#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_PATH="${ROOT_DIR}/.local/opensandbox/env.sh"
SESSION_DIR="${ROOT_DIR}/.local/opensandbox/manual-session"
CREATE_JSON="${SESSION_DIR}/create.json"
UPLOAD_SRC="${SESSION_DIR}/upload.txt"
DOWNLOAD_DST="${SESSION_DIR}/downloaded.txt"
GENERATED_DST="${SESSION_DIR}/generated.json"
ENDPOINT_BODY_DST="${SESSION_DIR}/endpoint.txt"
ENDPOINT_JSON="${SESSION_DIR}/endpoint.json"

if [[ ! -f "${ENV_PATH}" ]]; then
  echo "OpenSandbox is not initialized yet. Run: bun run opensandbox:init" >&2
  exit 1
fi

source "${ENV_PATH}"
mkdir -p "${SESSION_DIR}"

log_step() {
  printf '\n==> %s\n' "$1"
}

print_section() {
  local title="$1"
  printf '\n%s\n' "-- ${title} --"
}

osb_cli() {
  HOME="${OR3_NET_OPENSANDBOX_CLI_HOME}" \
    "${OR3_NET_OPENSANDBOX_VENV}/bin/osb" \
    --domain "${SANDBOX_DOMAIN}" \
    --protocol http \
    --api-key "${SANDBOX_API_KEY}" \
    "$@"
}

extract_json_field() {
  local field_name="$1"
  local json_path="$2"
  python3 - "$field_name" "$json_path" <<'PY'
import json
import sys
from pathlib import Path

field = sys.argv[1]
payload = json.loads(Path(sys.argv[2]).read_text())
stack = [payload]
while stack:
    item = stack.pop()
    if isinstance(item, dict):
        value = item.get(field)
        if isinstance(value, str) and value:
            print(value, end="")
            raise SystemExit(0)
        stack.extend(item.values())
    elif isinstance(item, list):
        stack.extend(item)
raise SystemExit(f"missing field: {field}")
PY
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

wait_for_server

log_step "creating fresh sandbox"
osb_cli -o json sandbox create \
  --image "${OR3_NET_OPENSANDBOX_DEFAULT_IMAGE}" \
  --timeout 15m \
  --ready-timeout "${OR3_NET_OPENSANDBOX_READY_TIMEOUT_SECONDS}s" \
  --entrypoint '["tail","-f","/dev/null"]' \
  > "${CREATE_JSON}"
cat "${CREATE_JSON}"
SANDBOX_ID="$(extract_json_field id "${CREATE_JSON}")"
printf 'sandbox_id=%s\n' "${SANDBOX_ID}"

cleanup() {
  if [[ -n "${SANDBOX_ID:-}" ]]; then
    log_step "cleaning up sandbox ${SANDBOX_ID}"
    osb_cli sandbox kill "${SANDBOX_ID}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

cat > "${UPLOAD_SRC}" <<'EOF'
hello from the host
line two for upload/download verification
EOF

log_step "uploading local file into sandbox"
osb_cli file mkdir "${SANDBOX_ID}" /workspace/manual >/dev/null
osb_cli file upload "${SANDBOX_ID}" "${UPLOAD_SRC}" /workspace/manual/upload.txt
printf '\n'

print_section "remote file contents after upload"
osb_cli file cat "${SANDBOX_ID}" /workspace/manual/upload.txt
printf '\n'

log_step "running commands inside sandbox"

print_section "byte count of uploaded file"
osb_cli exec "${SANDBOX_ID}" -- wc -c /workspace/manual/upload.txt
printf '\n'

print_section "stderr probe"
osb_cli exec "${SANDBOX_ID}" -- sh -c 'printf "this goes to stderr\n" >&2'
printf '\n'

print_section "mutating file from inside sandbox"
osb_cli exec "${SANDBOX_ID}" -- sh -c 'printf "appended from sandbox\n" >> /workspace/manual/upload.txt && echo ok'
printf '\n'

print_section "directory listing after mutation"
osb_cli exec "${SANDBOX_ID}" -- sh -c 'ls -la /workspace/manual > /tmp/ls-output.txt' >/dev/null
osb_cli file cat "${SANDBOX_ID}" /tmp/ls-output.txt
printf '\n'

log_step "downloading mutated file back to host"
osb_cli file download "${SANDBOX_ID}" /workspace/manual/upload.txt "${DOWNLOAD_DST}"
printf '\n'

print_section "downloaded file contents"
cat "${DOWNLOAD_DST}"
grep -q 'appended from sandbox' "${DOWNLOAD_DST}"

log_step "creating a new artifact inside sandbox"
osb_cli exec "${SANDBOX_ID}" -- python -c '
import json
from pathlib import Path
payload = {"status": "ok", "numbers": [1, 2, 3], "cwd": str(Path(".").resolve())}
Path("/workspace/manual/generated.json").write_text(json.dumps(payload, indent=2))
print("generated /workspace/manual/generated.json")
'
printf '\n'

log_step "downloading generated artifact"
osb_cli file download "${SANDBOX_ID}" /workspace/manual/generated.json "${GENERATED_DST}"
printf '\n'

print_section "downloaded generated artifact"
cat "${GENERATED_DST}"
printf '\n'
grep -q '"status": "ok"' "${GENERATED_DST}"

log_step "serving uploaded files over HTTP from inside sandbox"
osb_cli exec "${SANDBOX_ID}" -- sh -lc 'nohup python -m http.server 8002 --directory /workspace/manual >/tmp/or3-manual-http.log 2>&1 &' >/dev/null
sleep 2
osb_cli -o json sandbox endpoint "${SANDBOX_ID}" --port 8002 > "${ENDPOINT_JSON}"

print_section "endpoint metadata"
cat "${ENDPOINT_JSON}"
printf '\n'

ENDPOINT_URL="$(extract_json_field url "${ENDPOINT_JSON}" 2>/dev/null || true)"
if [[ -z "${ENDPOINT_URL}" ]]; then
  ENDPOINT_VALUE="$(extract_json_field endpoint "${ENDPOINT_JSON}")"
  ENDPOINT_URL="http://${ENDPOINT_VALUE}"
fi
printf 'endpoint=%s\n\n' "${ENDPOINT_URL}"

print_section "endpoint response body"
curl -fsS "${ENDPOINT_URL}/upload.txt" | tee "${ENDPOINT_BODY_DST}"
printf '\n'
grep -q 'hello from the host' "${ENDPOINT_BODY_DST}"

log_step "manual sandbox session passed"
