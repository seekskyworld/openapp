#!/usr/bin/env bash

# 通用 bundle 只有一个 Compose 文件；应用差异通过 manifest、Adapter 和环境注入。
openapp_compose_files=(-f docker-compose.yml)
# 这个值必须显式存在：deploy/preflight 使用 set -u，不能把 generic bundle
# 的“没有兼容 overlay”表达成未定义变量。
openapp_legacy_compose=false

openapp_assert_generic_layout() {
  local compatibility_flag
  for compatibility_flag in \
    OPENAPP_COMPATIBILITY_MODE \
    OPENAPP_BUNDLE_LEGACY_LAYOUT \
    OPENAPP_LEGACY_COMPOSE_OVERLAY \
    OPENAPP_LOCAL_COMPOSE; do
    case "${!compatibility_flag:-false}" in
      false|0|no) ;;
      *)
        echo "generic deployment cannot enable ${compatibility_flag}; use an explicit legacy bundle" >&2
        return 1
        ;;
    esac
  done

  local stale_path
  for stale_path in \
    docker-compose.legacy.yml \
    docker-compose.local.yml \
    backend/deployment/scripts/verify-runtime.sh \
    postgres/compat; do
    if [[ -e "${stale_path}" || -L "${stale_path}" ]]; then
      echo "generic deployment contains legacy compatibility artifact: ${stale_path}" >&2
      echo "move it to a separate rollback bundle before starting the generic stack" >&2
      return 1
    fi
  done
}

openapp_assert_generic_layout || exit 1

openapp_compose() {
  docker compose --env-file "${ENV_FILE}" "${openapp_compose_files[@]}" "$@"
}
