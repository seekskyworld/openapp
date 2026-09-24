#!/usr/bin/env bash
set -euo pipefail
# 旧布局由明确选择的 Adapter 维护；通用组合使用 export-openapp.mjs。
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
if [[ -z "${OPENAPP_ADAPTER_SOURCE_DIR:-}" ]]; then
  echo "OPENAPP_ADAPTER_SOURCE_DIR is required for a generic bundle" >&2
  exit 2
fi
export OPENAPP_CORE_SOURCE_ROOT="${ROOT_DIR}"
exec bash "${OPENAPP_ADAPTER_SOURCE_DIR}/scripts/export-legacy-bundle.sh" "$@"
