#!/usr/bin/env bash
set -euo pipefail
# 扫描实际构建的镜像及 OS 依赖；不把 npm 清单当成镜像 SBOM。
if [ "$#" -lt 2 ]; then
  echo 'usage: audit-images.sh <output-directory> <image> [image...]' >&2
  exit 2
fi
audit_output="$1"
shift
mkdir -p "$audit_output"
audit_output="$(cd "$audit_output" && pwd)"
scanner='aquasec/trivy:0.74.0@sha256:62b1e65e8869bc4b4c6aa4fa2b21595256c7c2f6018a9d9ad61caf87187c1969'
scanner_cache="$(docker volume create)"
trap 'docker volume rm "$scanner_cache" >/dev/null' EXIT
scanner_args=(--rm -v /var/run/docker.sock:/var/run/docker.sock:ro -v "$audit_output:/out" -v "$scanner_cache:/root/.cache/trivy")
# 容器无法使用宿主机回环代理；调用方可显式提供容器可达的代理地址。
if [ -n "${TRIVY_HTTP_PROXY:-}" ]; then
  scanner_args+=(-e "HTTP_PROXY=$TRIVY_HTTP_PROXY" -e "HTTPS_PROXY=$TRIVY_HTTP_PROXY")
fi
if [ -n "${TRIVY_DB_REPOSITORY:-}" ]; then
  scanner_args+=(-e "TRIVY_DB_REPOSITORY=$TRIVY_DB_REPOSITORY")
fi
index=0
failed=0
for image in "$@"; do
  index=$((index + 1))
  docker image inspect "$image" --format '{{json .RepoDigests}} {{.Id}}' > "$audit_output/image-$index.identity.txt"
  docker run "${scanner_args[@]}" "$scanner" \
    image --timeout 5m --scanners vuln --format cyclonedx --output "/out/image-$index.cdx.json" "$image" || failed=1
  docker run "${scanner_args[@]}" "$scanner" \
    image --timeout 5m --scanners vuln --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1 --format json --output "/out/image-$index.vulnerabilities.json" "$image" || failed=1
done
exit "$failed"
