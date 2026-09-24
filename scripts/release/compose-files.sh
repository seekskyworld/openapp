#!/usr/bin/env bash
# Called after the operational entry point loads core/.env.
: "${COMPOSE_PROJECT_NAME:?set the existing Compose project name in .env}"
: "${OPENAPP_DATA_ROOT:?set the existing absolute data root in .env}"
[[ "${OPENAPP_DATA_ROOT}" == /* && -d "${OPENAPP_DATA_ROOT}" ]] || {
  echo "OPENAPP_DATA_ROOT must be an existing absolute directory" >&2
  return 1 2>/dev/null || exit 1
}
openapp_compose_files=(-f "${ROOT_DIR}/docker-compose.yml")
case "${OPENAPP_COMPATIBILITY_MODE:-false}:${OPENAPP_BUNDLE_LEGACY_LAYOUT:-false}:${OPENAPP_LEGACY_COMPOSE_OVERLAY:-false}" in
  true:*|1:*|*:true:*|*:1:*|*:*:true|*:*:1)
    openapp_compose_files+=(-f "${ROOT_DIR}/docker-compose.legacy.yml") ;;
esac
case "${OPENAPP_LOCAL_COMPOSE:-false}" in
  true|1|yes) openapp_compose_files+=(-f "${ROOT_DIR}/docker-compose.local.yml") ;;
  false|0|no) ;;
  *) echo "invalid OPENAPP_LOCAL_COMPOSE" >&2; return 1 2>/dev/null || exit 1 ;;
esac
openapp_compose() {
  docker compose --project-name "${COMPOSE_PROJECT_NAME}" --project-directory "${ROOT_DIR}" \
    --env-file "${ENV_FILE}" "${openapp_compose_files[@]}" "$@"
}
