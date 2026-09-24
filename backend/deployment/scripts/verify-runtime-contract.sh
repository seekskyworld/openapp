#!/usr/bin/env bash
set -euo pipefail

# 验证通用 Runtime 合同和实例隔离边界。脚本只读取 profile 与部署环境，
# 不推断产品名称、认证供应商或业务数据；产品差异由 Adapter 声明并注入。
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PROFILE_PATH="${OPENAPP_RUNTIME_PROFILE:-$SCRIPT_DIR/../runtime/profile.json}"
TARGET_PLATFORM="${TARGET_PLATFORM:-linux/amd64}"
RUNTIME_BUILD="${OPENAPP_RUNTIME_BUILD:-false}"
# Core 不提供业务镜像构建器；需要构建时由 Adapter 显式传入。
RUNTIME_BUILD_SCRIPT="${OPENAPP_RUNTIME_BUILD_SCRIPT:-}"

[[ "$TARGET_PLATFORM" =~ ^linux/(amd64|arm64)$ ]] || {
  echo "TARGET_PLATFORM must be linux/amd64 or linux/arm64" >&2
  exit 1
}
[[ "$RUNTIME_BUILD" == true || "$RUNTIME_BUILD" == false ]] || {
  echo "OPENAPP_RUNTIME_BUILD must be true or false" >&2
  exit 1
}

# profile 支持 RuntimeProfile 扁平格式和 manifest 的 workload.runtime 嵌套格式。
PROFILE_VALUES="$(node - "$PROFILE_PATH" <<'NODE'
const fs = require("node:fs");
const path = process.argv[2];
let source = {};
if (path && fs.existsSync(path)) {
  try { source = JSON.parse(fs.readFileSync(path, "utf8")); }
  catch { console.error("runtime profile is not valid JSON: " + path); process.exit(1); }
}
const runtime = source && typeof source.runtime === "object" && source.runtime !== null
  ? source.runtime
  : source && source.workload && typeof source.workload.runtime === "object"
    ? source.workload.runtime
    : source;
const provider = runtime.providerEnvironment && typeof runtime.providerEnvironment === "object"
  ? runtime.providerEnvironment : {};
const text = (value) => typeof value === "string" && value.trim() ? value.trim() : "";
const first = (envKeys, profileKeys, fallback = "") => {
  for (const key of envKeys) { const value = text(process.env[key]); if (value) return value; }
  for (const key of profileKeys) { const value = text(runtime[key]); if (value) return value; }
  return fallback;
};
const integer = (envKeys, profileKeys, fallback) => {
  const value = first(envKeys, [], "") || profileKeys.map(key => runtime[key])
    .filter(value => typeof value === "number" || typeof value === "string")
    .map(String).find(value => value.trim()) || "";
  if (!value) return String(fallback);
  if (!/^[0-9]+$/u.test(value)) { console.error("runtime container port must be an integer"); process.exit(1); }
  return value;
};
const name = (value, label) => {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u.test(value)) { console.error(label + " is invalid"); process.exit(1); }
  return value;
};
const pathValue = (value, label) => {
  if (!value.startsWith("/") || value.includes("..") || value.includes("\0") || /[\r\n\t]/u.test(value)) {
    console.error(label + " is invalid"); process.exit(1);
  }
  return value;
};
const image = first(["OPENAPP_RUNTIME_IMAGE"], ["defaultImage", "image"], "openapp-runtime:0.1.0");
if (!/^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/u.test(image)) {
  console.error("runtime image reference is invalid"); process.exit(1);
}
const network = name(first(["OPENAPP_RUNTIME_NETWORK_PREFIX", "OPENAPP_NETWORK_NAME_PREFIX"],
  ["defaultNetworkPrefix", "networkPrefix"], "openapp-net-"), "runtime network prefix");
const container = name(first(["OPENAPP_RUNTIME_CONTAINER_PREFIX", "OPENAPP_CONTAINER_NAME_PREFIX"],
  ["defaultContainerPrefix", "containerPrefix"], "openapp-user-"), "runtime container prefix");
const volume = name(first(["OPENAPP_RUNTIME_VOLUME_PREFIX", "OPENAPP_VOLUME_NAME_PREFIX"],
  ["defaultVolumePrefix", "volumePrefix"], "openapp-data-"), "runtime volume prefix");
const egress = name(first(["OPENAPP_RUNTIME_EGRESS_NETWORK_PREFIX"],
  ["defaultEgressNetworkPrefix", "egressNetworkPrefix"], network + "egress-"), "runtime egress network prefix");
const mount = pathValue(first(["OPENAPP_RUNTIME_STORAGE_MOUNT_PATH", "OPENAPP_DATA_MOUNT_PATH"],
  ["storageMountPath", "mountPath"], "/var/lib/openapp"), "runtime storage mount path");
const health = pathValue(first(["OPENAPP_RUNTIME_HEALTH_PATH"], ["healthPath"], "/api/health"),
  "runtime health path");
const label = name(first(["OPENAPP_RUNTIME_LABEL_PREFIX", "OPENAPP_RESOURCE_LABEL_PREFIX"],
  ["labelPrefix"], "io.openapp.portal"), "runtime label prefix");
const port = integer(["OPENAPP_RUNTIME_CONTAINER_PORT", "OPENAPP_CONTAINER_PORT"],
  ["containerPort", "port"], 37371);
if (Number(port) < 1 || Number(port) > 65535) {
  console.error("runtime container port is out of range"); process.exit(1);
}
const providerKey = text(provider.authProviderKey);
const providerValue = providerKey
  ? text(process.env[providerKey]) || text(process.env.OPENAPP_AUTH_PROVIDER_BASE_URL)
    || text(process.env.AUTH_PROVIDER_BASE_URL) || text(provider.defaultAuthProviderBaseUrl)
  : "";
const allowedKey = text(provider.allowedOriginsKey);
const sandboxKey = text(provider.mcpAppSandboxOriginKey);
for (const pair of [[providerKey, "provider environment key"], [allowedKey, "allowed origins key"], [sandboxKey, "sandbox origin key"]]) {
  if (pair[0] && !/^[A-Z_][A-Z0-9_]{0,127}$/u.test(pair[0])) {
    console.error(pair[1] + " is invalid"); process.exit(1);
  }
}
for (const value of [network, container, volume, egress, mount, health, label, image, port, providerKey, providerValue, allowedKey, sandboxKey]) {
  if (/[\r\n\t\x1f]/u.test(value)) { console.error("runtime profile contains an unsupported control character"); process.exit(1); }
}
process.stdout.write([image, network, container, volume, egress, mount, port, health, label,
  providerKey, providerValue, allowedKey, sandboxKey].join("\x1f"));
NODE
)" || {
  echo "failed to load Runtime profile: $PROFILE_PATH" >&2
  exit 1
}
# 非空白分隔符保留可选字段的空列，避免 Provider 与 origin 键错位。
IFS=$'\x1f' read -r IMAGE NETWORK_PREFIX CONTAINER_PREFIX VOLUME_PREFIX EGRESS_NETWORK_PREFIX \
  STORAGE_MOUNT_PATH CONTAINER_PORT HEALTH_PATH LABEL_PREFIX PROVIDER_KEY PROVIDER_VALUE \
  ALLOWED_ORIGINS_KEY SANDBOX_ORIGIN_KEY <<< "$PROFILE_VALUES"

if [[ -n "${OPENAPP_RUNTIME_PROVIDER_ENV_JSON:-}" ]]; then
  node - "$OPENAPP_RUNTIME_PROVIDER_ENV_JSON" <<'NODE'
const value = process.argv[2];
let parsed;
try { parsed = JSON.parse(value); } catch { console.error("OPENAPP_RUNTIME_PROVIDER_ENV_JSON must be a JSON object"); process.exit(1); }
if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
  console.error("OPENAPP_RUNTIME_PROVIDER_ENV_JSON must be a JSON object"); process.exit(1);
}
for (const [key, raw] of Object.entries(parsed)) {
  if (!/^[A-Z_][A-Z0-9_]{0,127}$/u.test(key) || (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "boolean")) {
    console.error("OPENAPP_RUNTIME_PROVIDER_ENV_JSON contains an invalid entry"); process.exit(1);
  }
  if (/[\r\n\0]/u.test(String(raw))) {
    console.error("OPENAPP_RUNTIME_PROVIDER_ENV_JSON contains an unsupported value"); process.exit(1);
  }
}
NODE
fi

RUN_ID="${OPENAPP_RUNTIME_VERIFY_ID:-$$}"
[[ "$RUN_ID" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$ ]] || {
  echo "OPENAPP_RUNTIME_VERIFY_ID is invalid" >&2
  exit 1
}
PROBE_IMAGE="${OPENAPP_RUNTIME_PROBE_IMAGE:-node:24-bookworm-slim}"
[[ "$PROBE_IMAGE" =~ ^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$ ]] || {
  echo "OPENAPP_RUNTIME_PROBE_IMAGE is invalid" >&2
  exit 1
}

PORTAL_PROBE="openapp-portal-probe-$RUN_ID"
INSTANCE_A="verify-a-$RUN_ID"
INSTANCE_B="verify-b-$RUN_ID"
NETWORK_A="$NETWORK_PREFIX$INSTANCE_A"
NETWORK_B="$NETWORK_PREFIX$INSTANCE_B"
EGRESS_NETWORK_A="$EGRESS_NETWORK_PREFIX$INSTANCE_A"
EGRESS_NETWORK_B="$EGRESS_NETWORK_PREFIX$INSTANCE_B"
CONTAINER_A="$CONTAINER_PREFIX$INSTANCE_A"
CONTAINER_B="$CONTAINER_PREFIX$INSTANCE_B"
VOLUME_A="$VOLUME_PREFIX$INSTANCE_A"
VOLUME_B="$VOLUME_PREFIX$INSTANCE_B"

for resource in "$PORTAL_PROBE" "$NETWORK_A" "$NETWORK_B" "$EGRESS_NETWORK_A" "$EGRESS_NETWORK_B" \
  "$CONTAINER_A" "$CONTAINER_B" "$VOLUME_A" "$VOLUME_B"; do
  [[ "$resource" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]] || {
    echo "derived runtime resource name is invalid: $resource" >&2
    exit 1
  }
done

if [[ "$RUNTIME_BUILD" == true ]]; then
  [[ -n "$RUNTIME_BUILD_SCRIPT" ]] || { echo "OPENAPP_RUNTIME_BUILD_SCRIPT must select an Adapter-owned builder" >&2; exit 1; }
  [[ -x "$RUNTIME_BUILD_SCRIPT" ]] || {
    echo "runtime build script is missing or not executable: $RUNTIME_BUILD_SCRIPT" >&2
    exit 1
  }
  "$RUNTIME_BUILD_SCRIPT"
fi

actual_platform="$(docker image inspect "$IMAGE" --format '{{.Os}}/{{.Architecture}}' 2>/dev/null || true)"
[[ "$actual_platform" == "$TARGET_PLATFORM" ]] || {
  echo "runtime image platform mismatch: expected $TARGET_PLATFORM, got $actual_platform" >&2
  exit 1
}

cleanup() {
  docker rm --force "$PORTAL_PROBE" "$CONTAINER_A" "$CONTAINER_B" >/dev/null 2>&1 || true
  docker volume rm "$VOLUME_A" "$VOLUME_B" >/dev/null 2>&1 || true
  docker network rm "$NETWORK_A" "$NETWORK_B" "$EGRESS_NETWORK_A" "$EGRESS_NETWORK_B" >/dev/null 2>&1 || true
}
trap cleanup EXIT

resource_labels() {
  local instance_id="$1"
  local owner_id="$2"
  printf '%s\n' \
    --label "$LABEL_PREFIX.managed=true" \
    --label "$LABEL_PREFIX.instance-id=$instance_id" \
    --label "$LABEL_PREFIX.owner-id=$owner_id"
}

provider_env_args() {
  local portal_origin="http://$PORTAL_PROBE"
  if [[ -n "$PROVIDER_KEY" && -n "$PROVIDER_VALUE" ]]; then
    printf '%s\t%s\n' --env "$PROVIDER_KEY=$PROVIDER_VALUE"
  fi
  if [[ -n "$ALLOWED_ORIGINS_KEY" ]]; then
    printf '%s\t%s\n' --env "$ALLOWED_ORIGINS_KEY=$portal_origin"
  fi
  if [[ -n "$SANDBOX_ORIGIN_KEY" && -n "${OPENAPP_MCP_APP_SANDBOX_ORIGIN:-}" ]]; then
    printf '%s\t%s\n' --env "$SANDBOX_ORIGIN_KEY=$OPENAPP_MCP_APP_SANDBOX_ORIGIN"
  fi
  if [[ -n "${OPENAPP_RUNTIME_PROVIDER_ENV_JSON:-}" ]]; then
    node - "$OPENAPP_RUNTIME_PROVIDER_ENV_JSON" <<'NODE'
const value = process.argv[2];
let parsed;
try { parsed = JSON.parse(value); } catch { console.error("OPENAPP_RUNTIME_PROVIDER_ENV_JSON must be a JSON object"); process.exit(1); }
if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
  console.error("OPENAPP_RUNTIME_PROVIDER_ENV_JSON must be a JSON object"); process.exit(1);
}
for (const [key, raw] of Object.entries(parsed)) {
  if (!/^[A-Z_][A-Z0-9_]{0,127}$/u.test(key) || (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "boolean")) {
    console.error("OPENAPP_RUNTIME_PROVIDER_ENV_JSON contains an invalid entry"); process.exit(1);
  }
  const value = String(raw);
  if (/[\r\n\0]/u.test(value)) {
    console.error("OPENAPP_RUNTIME_PROVIDER_ENV_JSON contains an unsupported value"); process.exit(1);
  }
  process.stdout.write("--env\t" + key + "=" + value + "\n");
}
NODE
  fi
}

create_instance() {
  local instance_id="$1"
  local owner_id="$2"
  local network="$3"
  local egress_network="$4"
  local volume="$5"
  local container="$6"
  local labels=()
  local provider_args=()
  while IFS= read -r value; do labels+=("$value"); done < <(resource_labels "$instance_id" "$owner_id")
  while IFS=$'\t' read -r key value; do
    [[ -n "$key" ]] || continue
    provider_args+=("$key" "$value")
  done < <(provider_env_args)

  local subnet="${OPENAPP_RUNTIME_VERIFY_SUBNET_A:-}"
  local egress_subnet="${OPENAPP_RUNTIME_VERIFY_EGRESS_SUBNET_A:-}"
  if [[ "$instance_id" == "$INSTANCE_B" ]]; then
    subnet="${OPENAPP_RUNTIME_VERIFY_SUBNET_B:-}"
    egress_subnet="${OPENAPP_RUNTIME_VERIFY_EGRESS_SUBNET_B:-}"
  fi
  local subnet_args=() egress_subnet_args=()
  [[ -z "$subnet" ]] || subnet_args=(--subnet "$subnet")
  [[ -z "$egress_subnet" ]] || egress_subnet_args=(--subnet "$egress_subnet")
  docker network create --internal "${subnet_args[@]}" "${labels[@]}" "$network" >/dev/null
  # 验证网络本身也保持租户隔离；生产环境如需出网，应由独立出口代理提供，
  # 不能依赖多个 bridge 的默认路由互相隔离。
  docker network create --internal --opt com.docker.network.bridge.enable_icc=false "${egress_subnet_args[@]}" "${labels[@]}" "$egress_network" >/dev/null
  docker volume create "${labels[@]}" "$volume" >/dev/null
  docker create \
    --name "$container" \
    --network "$network" \
    "${labels[@]}" \
    --mount "type=volume,source=$volume,target=$STORAGE_MOUNT_PATH" \
    --memory 1g \
    --cpus 1 \
    --pids-limit 256 \
    --cap-drop ALL \
    --security-opt no-new-privileges=true \
    --restart no \
    "${provider_args[@]}" \
    "$IMAGE" >/dev/null
  docker network connect "$egress_network" "$container" >/dev/null
  docker start "$container" >/dev/null
}

probe_health() {
  local container="$1"
  docker exec "$PORTAL_PROBE" node -e \
    'fetch("http://" + process.argv[1] + ":" + process.argv[2] + process.argv[3], { signal: AbortSignal.timeout(2000) }).then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))' \
    "$container" "$CONTAINER_PORT" "$HEALTH_PATH"
}

wait_for_health() {
  local container="$1"
  for _ in $(seq 1 60); do
    if probe_health "$container" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  docker logs "$container" >&2 || true
  echo "$container did not become healthy" >&2
  return 1
}

can_connect() {
  local source_container="$1"
  local target="$2"
  # 独立工具容器共享被测实例的网络命名空间，不要求业务镜像安装 Node。
  # 42 仅表示预期的不可达；Docker、解释器或其他探针故障必须使验收失败。
  docker run --rm --network "container:$source_container" --read-only --cap-drop ALL \
    --security-opt no-new-privileges=true --entrypoint node "$PROBE_IMAGE" -e \
    'const net=require("node:net");const socket=net.connect(Number(process.argv[2]),process.argv[1]);socket.setTimeout(2000);socket.once("connect",()=>process.exit(0));socket.once("error",e=>{if(["ECONNREFUSED","ETIMEDOUT","EHOSTUNREACH","ENETUNREACH","ENOTFOUND","EAI_AGAIN"].includes(e.code))process.exit(42);console.error("probe_failed",e.code);process.exit(70)});socket.once("timeout",()=>process.exit(42));' \
    "$target" "$CONTAINER_PORT"
}

assert_isolated() {
  local result=0
  can_connect "$1" "$2" || result=$?
  case "$result" in
    42) return 0 ;;
    0) echo "isolation failed: source reached target" >&2 ;;
    *) echo "isolation probe failed (exit $result); isolation is unverified" >&2 ;;
  esac
  return 1
}

create_instance "$INSTANCE_A" runtime-verifier-a "$NETWORK_A" "$EGRESS_NETWORK_A" "$VOLUME_A" "$CONTAINER_A"
create_instance "$INSTANCE_B" runtime-verifier-b "$NETWORK_B" "$EGRESS_NETWORK_B" "$VOLUME_B" "$CONTAINER_B"

# Portal 探针同时加入两张网络，代表控制面访问两个实例；实例本身只能加入自己的网络。
docker run --detach --name "$PORTAL_PROBE" --network "$NETWORK_A" --entrypoint sleep "$PROBE_IMAGE" 300 >/dev/null
docker network connect "$NETWORK_B" "$PORTAL_PROBE" >/dev/null

wait_for_health "$CONTAINER_A"
wait_for_health "$CONTAINER_B"

for container in "$CONTAINER_A" "$CONTAINER_B"; do
  actual_mount="$(docker inspect --format "{{range .Mounts}}{{if eq .Destination \"$STORAGE_MOUNT_PATH\"}}{{.Source}}{{end}}{{end}}" "$container")"
  [[ -n "$actual_mount" ]] || {
    echo "$container is not mounted at $STORAGE_MOUNT_PATH" >&2
    exit 1
  }
  actual_instance="$(docker inspect --format "{{index .Config.Labels \"$LABEL_PREFIX.instance-id\"}}" "$container")"
  [[ -n "$actual_instance" ]] || {
    echo "$container is missing the Runtime contract label" >&2
    exit 1
  }
done

CONTAINER_B_PRIVATE_IP="$(docker inspect --format "{{(index .NetworkSettings.Networks \"$NETWORK_B\").IPAddress}}" "$CONTAINER_B")"
CONTAINER_B_EGRESS_IP="$(docker inspect --format "{{(index .NetworkSettings.Networks \"$EGRESS_NETWORK_B\").IPAddress}}" "$CONTAINER_B")"
[[ -n "$CONTAINER_B_PRIVATE_IP" && -n "$CONTAINER_B_EGRESS_IP" ]] || {
  echo "could not determine target instance network addresses" >&2
  exit 1
}

# 先证明相同探针在源命名空间能访问本实例，再执行负向隔离检查。
can_connect "$CONTAINER_A" 127.0.0.1 || { echo "source probe self-check failed" >&2; exit 1; }
assert_isolated "$CONTAINER_A" "$CONTAINER_B"
assert_isolated "$CONTAINER_A" "$CONTAINER_B_PRIVATE_IP"
assert_isolated "$CONTAINER_A" "$CONTAINER_B_EGRESS_IP"

# 删除 A 后再次探测 B，验证资源清理不会误伤其他租户。
docker rm --force "$CONTAINER_A" >/dev/null
docker network disconnect --force "$NETWORK_A" "$PORTAL_PROBE" >/dev/null 2>&1 || true
docker volume rm "$VOLUME_A" >/dev/null
docker network rm "$NETWORK_A" >/dev/null
docker network rm "$EGRESS_NETWORK_A" >/dev/null
probe_health "$CONTAINER_B"

echo "Runtime contract verified: profile-driven resources, Portal -> A/B health, A !-> B, deleting A leaves B healthy"
