#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="${ROOT_DIR}/.local/opensandbox"
VENV_DIR="${STATE_DIR}/.venv"
CLI_HOME="${STATE_DIR}/home"
CONFIG_PATH="${STATE_DIR}/config.toml"
ENV_PATH="${STATE_DIR}/env.sh"
LOG_DIR="${STATE_DIR}/logs"
TOOLCHAIN_STAMP_PATH="${STATE_DIR}/toolchain.stamp"
PYTHON_VERSION="${OR3_NET_OPENSANDBOX_PYTHON_VERSION:-3.11}"
HOST="${OR3_NET_OPENSANDBOX_HOST:-127.0.0.1}"
PORT="${OR3_NET_OPENSANDBOX_PORT:-8080}"
API_KEY="${OR3_NET_OPENSANDBOX_API_KEY:-or3-net-local-opensandbox}"
DEFAULT_IMAGE="${OR3_NET_OPENSANDBOX_DEFAULT_IMAGE:-python:3.11-slim}"
EXECD_IMAGE="${OR3_NET_OPENSANDBOX_EXECD_IMAGE:-opensandbox/execd:v1.0.7}"
READY_TIMEOUT_SECONDS="${OR3_NET_OPENSANDBOX_READY_TIMEOUT_SECONDS:-120}"
FORCE_REINSTALL="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --refresh|--force-reinstall)
      FORCE_REINSTALL="true"
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      echo "Usage: bash ./scripts/opensandbox/opensandbox-init.sh [--refresh]" >&2
      exit 1
      ;;
  esac
done

mkdir -p "${STATE_DIR}" "${CLI_HOME}" "${LOG_DIR}"

log_step() {
  printf '\n==> %s\n' "$1"
}

ensure_uv() {
  if command -v uv >/dev/null 2>&1; then
    return
  fi
  if ! command -v curl >/dev/null 2>&1; then
    echo "curl is required to install uv" >&2
    exit 1
  fi
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="${HOME}/.local/bin:${PATH}"
  if ! command -v uv >/dev/null 2>&1; then
    echo "uv installation completed but uv is not on PATH" >&2
    exit 1
  fi
}

python_major_minor() {
  local version
  version="$1"
  version="${version#Python }"
  version="${version%%[^0-9.]*}"
  printf '%s\n' "${version}" | awk -F. '{ print ($1 * 1000) + $2 }'
}

ensure_python() {
  local current=""
  if command -v python3 >/dev/null 2>&1; then
    current="$(python3 --version 2>/dev/null || true)"
  fi

  if [[ -n "${current}" ]] && [[ "$(python_major_minor "${current}")" -ge 3010 ]]; then
    log_step "python3 already satisfies the minimum version (${current})"
    return
  fi

  log_step "installing Python ${PYTHON_VERSION} via uv"
  uv python install "${PYTHON_VERSION}"
}

wait_for_docker() {
  local attempts=0
  until docker version >/dev/null 2>&1; do
    attempts=$((attempts + 1))
    if [[ "$(uname -s)" == "Darwin" ]] && [[ ${attempts} -eq 1 ]] && [[ -d /Applications/Docker.app || -d "${HOME}/Applications/Docker.app" ]]; then
      open -a Docker >/dev/null 2>&1 || true
    fi
    if [[ ${attempts} -ge 90 ]]; then
      echo "Docker is installed but not running. Start Docker Desktop and rerun this command." >&2
      exit 1
    fi
    sleep 2
  done
}

ensure_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "Docker is required for local OpenSandbox testing." >&2
    echo "Install Docker Desktop, then rerun this command." >&2
    exit 1
  fi
  log_step "verifying Docker availability"
  wait_for_docker
}

toolchain_stamp() {
  cat <<EOF
python=${PYTHON_VERSION}
default_image=${DEFAULT_IMAGE}
execd_image=${EXECD_IMAGE}
EOF
}

toolchain_is_current() {
  if [[ "${FORCE_REINSTALL}" == "true" ]]; then
    return 1
  fi

  if [[ ! -x "${VENV_DIR}/bin/python" ]] || [[ ! -x "${VENV_DIR}/bin/opensandbox-server" ]] || [[ ! -x "${VENV_DIR}/bin/osb" ]]; then
    return 1
  fi

  if [[ ! -f "${TOOLCHAIN_STAMP_PATH}" ]]; then
    return 1
  fi

  if [[ "$(cat "${TOOLCHAIN_STAMP_PATH}")" != "$(toolchain_stamp)" ]]; then
    return 1
  fi

  return 0
}

write_toolchain_stamp() {
  toolchain_stamp > "${TOOLCHAIN_STAMP_PATH}"
}

write_config() {
  cat >"${CONFIG_PATH}" <<EOF
[server]
host = "${HOST}"
port = ${PORT}
log_level = "INFO"
api_key = "${API_KEY}"
max_sandbox_timeout_seconds = 86400

[runtime]
type = "docker"
execd_image = "${EXECD_IMAGE}"

[docker]
network_mode = "bridge"
EOF
}

write_env_file() {
  cat >"${ENV_PATH}" <<EOF
export OR3_NET_OPENSANDBOX_ROOT="${STATE_DIR}"
export OR3_NET_OPENSANDBOX_VENV="${VENV_DIR}"
export OR3_NET_OPENSANDBOX_CLI_HOME="${CLI_HOME}"
export OR3_NET_OPENSANDBOX_CONFIG="${CONFIG_PATH}"
export OR3_NET_OPENSANDBOX_LOG_DIR="${LOG_DIR}"
export PATH="${VENV_DIR}/bin:\${PATH}"
export SANDBOX_CONFIG_PATH="${CONFIG_PATH}"
export SANDBOX_DOMAIN="${HOST}:${PORT}"
export SANDBOX_API_KEY="${API_KEY}"
export OR3_NET_OPENSANDBOX_API_KEY="${API_KEY}"
export OR3_NET_OPENSANDBOX_DOMAIN="${HOST}:${PORT}"
export OR3_NET_OPENSANDBOX_PROTOCOL="http"
export OR3_NET_OPENSANDBOX_USE_SERVER_PROXY="false"
export OR3_NET_OPENSANDBOX_DEFAULT_IMAGE="${DEFAULT_IMAGE}"
export OR3_NET_OPENSANDBOX_READY_TIMEOUT_SECONDS="${READY_TIMEOUT_SECONDS}"
EOF
}

install_python_packages() {
  if toolchain_is_current; then
    log_step "reusing existing OpenSandbox virtualenv"
    return
  fi

  log_step "creating or refreshing the OpenSandbox virtualenv"
  uv venv "${VENV_DIR}" --python "${PYTHON_VERSION}" --clear
  log_step "installing opensandbox and opensandbox-server"
  uv pip install --python "${VENV_DIR}/bin/python" opensandbox opensandbox-server
  log_step "installing osb CLI"
  if ! uv pip install --python "${VENV_DIR}/bin/python" opensandbox-cli; then
    log_step "registry install unavailable; falling back to GitHub CLI source"
    uv pip install --python "${VENV_DIR}/bin/python" "git+https://github.com/alibaba/OpenSandbox.git#subdirectory=cli"
  fi
  write_toolchain_stamp
}

pull_images() {
  if docker image inspect "${DEFAULT_IMAGE}" >/dev/null 2>&1; then
    log_step "default image already present (${DEFAULT_IMAGE})"
  else
    log_step "pulling default image (${DEFAULT_IMAGE})"
    docker pull "${DEFAULT_IMAGE}"
  fi

  if docker image inspect "${EXECD_IMAGE}" >/dev/null 2>&1; then
    log_step "execd image already present (${EXECD_IMAGE})"
  else
    log_step "pulling execd image (${EXECD_IMAGE})"
    docker pull "${EXECD_IMAGE}"
  fi
}

verify_tools() {
  log_step "verifying local OpenSandbox tools"
  "${VENV_DIR}/bin/python" --version
  "${VENV_DIR}/bin/opensandbox-server" -h >/dev/null
  HOME="${CLI_HOME}" "${VENV_DIR}/bin/osb" --help >/dev/null
}

ensure_uv
ensure_python
ensure_docker
install_python_packages
write_toolchain_stamp
write_config
write_env_file
pull_images
verify_tools

cat <<EOF
OpenSandbox bootstrap complete.

Source the local environment with:
  source "${ENV_PATH}"

Start the local server with:
  bash "${ROOT_DIR}/scripts/opensandbox/opensandbox-server.sh"

Run the OR3 integration smoke test with:
  bun "${ROOT_DIR}/scripts/opensandbox/opensandbox-manual-test.ts"

Run the OpenSandbox CLI smoke test with:
  bash "${ROOT_DIR}/scripts/opensandbox/opensandbox-cli-smoke.sh"

Run the full manual CLI session with:
  bash "${ROOT_DIR}/scripts/opensandbox/opensandbox-manual-cli-session.sh"
EOF
