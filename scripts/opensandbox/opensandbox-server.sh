#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_PATH="${ROOT_DIR}/.local/opensandbox/env.sh"

if [[ ! -f "${ENV_PATH}" ]]; then
  echo "OpenSandbox is not initialized yet. Run: bash ./scripts/opensandbox/opensandbox-init.sh" >&2
  exit 1
fi

source "${ENV_PATH}"
exec "${OR3_NET_OPENSANDBOX_VENV}/bin/opensandbox-server" --config "${OR3_NET_OPENSANDBOX_CONFIG}" "$@"
