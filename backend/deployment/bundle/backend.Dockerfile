ARG DOCKER_CLI_IMAGE=docker:29-cli@sha256:018edbc908e08fcc9dbf029c812c34251e9b4719e6f71ca0e5eae2a987d014ca
ARG NODE_BASE_IMAGE=node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
FROM ${DOCKER_CLI_IMAGE} AS docker-cli

FROM ${NODE_BASE_IMAGE}

ARG NPM_REGISTRY=

# 官方 Docker CLI 镜像已含 CA bundle，复用它避免仅为证书下载整个 apt 索引。
COPY --from=docker-cli /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
RUN groupadd --gid 10001 portal \
    && useradd --uid 10001 --gid 10001 --home-dir /app --create-home portal

WORKDIR /app/backend
COPY LICENSE /app/LICENSE
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY backend/package.json backend/package-lock.json ./
COPY backend/runtime/package.json backend/runtime/package-lock.json ./runtime/
COPY backend/runtime/dist ./runtime/dist
# 将本地合同包放到 package.json 声明的相对路径，避免 npm ci 越过部署构建上下文。
COPY packages/contracts /app/packages/contracts
RUN if [ -n "${NPM_REGISTRY}" ]; then npm config set registry "${NPM_REGISTRY}"; fi \
    && npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force \
    && rm -rf /usr/local/lib/node_modules/npm \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx
# 运行镜像只执行已编译代码；构建期 npm 不进入运行期，避免携带其无关依赖漏洞。

COPY backend/dist ./dist
COPY backend/deployment ./deployment
# 适配器只通过公开合同边界在运行时加载，Core 不读取适配器的内部源码。
# 导出器只放入经过审核的 Adapter dist；运行时仍由环境变量选择具体模块。
# 这样通用 bundle 不需要在 Dockerfile 中写死某一个产品目录。
COPY adapters/ ./adapters/
# 构建上下文可能来自未清理的本地 dist；镜像内再次按固定清单裁剪，避免
# generic Portal 因旧构建缓存携带兼容实现。
COPY scripts/prune-generic-artifacts.mjs /tmp/prune-generic-artifacts.mjs
COPY scripts/compatibility-manifest.mjs scripts/boundary-policy.mjs /tmp/
RUN node /tmp/prune-generic-artifacts.mjs --root /app \
    && rm /tmp/prune-generic-artifacts.mjs \
    && test ! -e /app/backend/deployment/scripts/verify-runtime.sh
# Adapter 可以只引用已有镜像；未提供构建脚本时不应阻断 Core 镜像构建。
RUN chmod 0755 deployment/scripts/*.sh \
    && for script in adapters/*/deployment/build/*.sh; do \
         if [ -f "$script" ]; then chmod 0755 "$script" || exit 1; fi; \
       done \
    && mkdir -p /app/releases \
    && chown -R portal:portal /app

ARG OPENAPP_DEPLOYMENT_SOURCE_SHA256
LABEL io.openapp.deployment-source-sha256="${OPENAPP_DEPLOYMENT_SOURCE_SHA256}"

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=14313 \
    CONTAINER_RUNTIME=docker \
    CONTAINER_RUNTIME_ENDPOINT_MODE=network \
    PORTAL_STATIC_DIR=/app/public

USER portal
EXPOSE 14313
CMD ["node", "dist/server-generic.js"]
