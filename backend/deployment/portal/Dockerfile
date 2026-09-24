ARG NODE_BASE_IMAGE=node:24-bookworm-slim
ARG DOCKER_CLI_IMAGE=docker:29-cli
FROM ${DOCKER_CLI_IMAGE} AS docker-cli

FROM ${NODE_BASE_IMAGE} AS runtime-build
WORKDIR /build/runtime
COPY backend/runtime/package.json backend/runtime/package-lock.json backend/runtime/tsconfig.json backend/runtime/tsconfig.generic.json ./
COPY backend/runtime/src ./src
COPY backend/scripts /build/scripts
ARG NPM_REGISTRY=
RUN if [ -n "${NPM_REGISTRY}" ]; then npm config set registry "${NPM_REGISTRY}"; fi \
    && npm ci && npm run build:generic && npm prune --omit=dev

FROM ${NODE_BASE_IMAGE} AS backend-build
WORKDIR /build
COPY --from=runtime-build /build/runtime ./backend/runtime
COPY packages/contracts ./packages/contracts
COPY backend/package.json backend/package-lock.json backend/tsconfig.json backend/tsconfig.generic.json ./backend/
COPY backend/src ./backend/src
COPY backend/scripts ./backend/scripts
COPY package.json package-lock.json ./
ARG NPM_REGISTRY=
RUN if [ -n "${NPM_REGISTRY}" ]; then npm config set registry "${NPM_REGISTRY}"; fi \
    && npm ci && npm --prefix packages/contracts run build
WORKDIR /build/backend
ARG NPM_REGISTRY=
RUN if [ -n "${NPM_REGISTRY}" ]; then npm config set registry "${NPM_REGISTRY}"; fi \
    && npm ci && npm run build:generic && npm prune --omit=dev

FROM ${NODE_BASE_IMAGE} AS frontend-build
WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json frontend/tsconfig.json frontend/vite.config.ts frontend/index.html ./
COPY frontend/src ./src
COPY frontend/public ./public
COPY scripts/compatibility-manifest.mjs scripts/boundary-policy.mjs scripts/verify-frontend-artifact.mjs /build/scripts/
ARG NPM_REGISTRY=
RUN if [ -n "${NPM_REGISTRY}" ]; then npm config set registry "${NPM_REGISTRY}"; fi \
    && npm ci && npm run build:generic

FROM ${NODE_BASE_IMAGE} AS generic-artifact-sanitize
WORKDIR /sanitize
COPY --from=runtime-build /build/runtime/dist ./backend/runtime/dist
COPY --from=backend-build /build/backend/dist ./backend/dist
COPY --from=frontend-build /build/frontend/dist ./frontend/web
COPY scripts/prune-generic-artifacts.mjs ./prune-generic-artifacts.mjs
COPY scripts/compatibility-manifest.mjs scripts/boundary-policy.mjs ./
# 统一在一个临时根内裁剪三类生成物；最终镜像只复制裁剪后的目录。
RUN cd / && node /sanitize/prune-generic-artifacts.mjs --root /sanitize

FROM ${NODE_BASE_IMAGE}
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
ARG DEBIAN_MIRROR=
RUN if [ -n "${DEBIAN_MIRROR}" ]; then \
      sed -i "s|deb.debian.org|${DEBIAN_MIRROR}|g; s|security.debian.org|${DEBIAN_MIRROR}|g" /etc/apt/sources.list.d/debian.sources; \
    fi \
    && apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 portal \
    && useradd --uid 10001 --gid 10001 --home-dir /app --create-home portal

WORKDIR /app
COPY LICENSE /app/LICENSE
# 最终层只携带生产运行所需的 package metadata、裁剪后的依赖和 dist。
# 不复制 `/build/backend` 整棵树，避免源码、兼容 facade、测试和构建输入进入
# generic Portal 镜像；Node 的 file 依赖仍通过下面的 contracts/runtime 目录解析。
COPY --from=backend-build --chown=portal:portal /build/backend/package.json /build/backend/package-lock.json ./backend/
COPY --from=backend-build --chown=portal:portal /build/backend/node_modules ./backend/node_modules
COPY --from=runtime-build --chown=portal:portal /build/runtime/package.json /build/runtime/package-lock.json ./backend/runtime/
COPY --from=runtime-build --chown=portal:portal /build/runtime/node_modules ./backend/runtime/node_modules
COPY --from=backend-build --chown=portal:portal /build/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=backend-build --chown=portal:portal /build/packages/contracts/dist ./packages/contracts/dist
COPY --from=generic-artifact-sanitize --chown=portal:portal /sanitize/backend/dist ./backend/dist
COPY --from=generic-artifact-sanitize --chown=portal:portal /sanitize/backend/runtime/dist ./backend/runtime/dist
COPY --from=generic-artifact-sanitize --chown=portal:portal /sanitize/frontend/web ./public
# App 构建器、Dockerfile 与启动脚本均由 Adapter 发布，纯 Core 镜像不携带它们。
# 这些路径一旦出现，说明构建上下文把兼容实现或源码带进了 generic 镜像，
# 直接让镜像构建失败，而不是等运行时才发现产品边界被污染。
RUN test ! -e /app/backend/src \
    && test ! -e /app/backend/dist/server.js \
    && test ! -e /app/backend/dist/server-compat.js \
    && test ! -e /app/backend/runtime/dist/runtime-compat.js

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORTAL_STATIC_DIR=/app/public \
    PORT=14310
USER portal
EXPOSE 14310
CMD ["node", "backend/dist/server-generic.js"]
