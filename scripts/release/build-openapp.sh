#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
node verify.mjs
release_sha="$(node -p 'require("./release-manifest.json").sourceFingerprint')"
backend_image="${BACKEND_IMAGE:-openapp-portal-backend:release-${release_sha:0:12}}"
frontend_image="${FRONTEND_IMAGE:-openapp-frontend:release-${release_sha:0:12}}"
docker build --platform "${TARGET_PLATFORM:-linux/amd64}" \
  --build-arg "OPENAPP_DEPLOYMENT_SOURCE_SHA256=${release_sha}" \
  --build-arg "NODE_BASE_IMAGE=${NODE_BASE_IMAGE:-node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6}" \
  --build-arg "DOCKER_CLI_IMAGE=${DOCKER_CLI_IMAGE:-docker:29-cli@sha256:018edbc908e08fcc9dbf029c812c34251e9b4719e6f71ca0e5eae2a987d014ca}" \
  --build-arg "NPM_REGISTRY=${NPM_REGISTRY:-}" \
  --build-arg "DEBIAN_MIRROR=${DEBIAN_MIRROR:-}" \
  -f core/backend/Dockerfile -t "${backend_image}" .
docker build --platform "${TARGET_PLATFORM:-linux/amd64}" \
  --build-arg "OPENAPP_DEPLOYMENT_SOURCE_SHA256=${release_sha}" \
  --build-arg "NGINX_BASE_IMAGE=${NGINX_BASE_IMAGE:-nginx:stable-alpine@sha256:ef8676b33d681f272ba429b27658bdd7e640963279714c96bddf1dc76307f7b6}" \
  -f core/frontend/Dockerfile -t "${frontend_image}" core/frontend
printf 'Built control-plane images only:\n%s\n%s\n' "${backend_image}" "${frontend_image}"
