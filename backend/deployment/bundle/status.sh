#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
cd "${ROOT_DIR}"
ENV_FILE="${DEPLOYMENT_ENV_FILE:-.env}"
[[ -f "${ENV_FILE}" ]] || { echo "deployment env file not found: ${ENV_FILE}" >&2; exit 1; }
set -a
. "${ENV_FILE}"
set +a
source "${ROOT_DIR}/compose-files.sh"

openapp_compose ps
curl --noproxy '*' -fsS "${PORTAL_PUBLIC_BASE_URL:?set PORTAL_PUBLIC_BASE_URL in .env}/api/health"
printf '\n'
