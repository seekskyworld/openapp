# 首次安装与管理员初始化

本文只用于全新安装。升级已有部署必须保留原 Compose 项目、容器名称、数据库及业务目录，并按恢复手册演练；不要使用新数据目录替换旧库。

以下可复制命令演示**纯 Core**。如果目标是让用户运行自己的应用，请走
Core 源码仓库中的 `docs/adapter-tutorial.md`，其中明确启动 Socket Proxy、准备业务镜像并验证双用户访问。
该教程需要源码仓库；当前文档也会随生成包交付，不应假定生成包包含全部开发示例。
不要在已经导出的组合包旁重新执行下面的空插件导出命令，那会得到另一个没有应用能力的包。

使用 Node.js 24 LTS、npm、Docker Engine／OrbStack 和 Docker Compose v2。
在 Core 源码根目录安装依赖，然后导出不带 Adapter 的控制面：

```sh
npm ci
npm --prefix backend/runtime ci
npm --prefix backend ci
npm --prefix frontend ci
npm run release:openapp -- config/core.release.json /tmp/openapp-core-release
cd /tmp/openapp-core-release
node verify.mjs
bash build-images.sh
cp core/.env.example core/.env
chmod 600 core/.env
```

构建脚本输出两个带指纹的镜像名。将它们分别填到 `core/.env` 的 BACKEND_IMAGE、FRONTEND_IMAGE。设置唯一的 COMPOSE_PROJECT_NAME、绝对 OPENAPP_DATA_ROOT，生成独立 POSTGRES_PASSWORD 和 OPENAPP_ADMIN_CLI_TOKEN；后两者可分别用 `openssl rand -hex 32` 生成。配置实际访问地址、PORTAL_PORT 与 PORTAL_BACKEND_PORT。纯 Core 保持 OPENAPP_CONTROL_PLANE_ONLY=true、OPENAPP_ADAPTER_REQUIRED=false。

以 `/srv/openapp-data` 为全新数据目录示例（已有部署不要执行这一组初始化）：

```sh
sudo install -d /srv/openapp-data/postgres/data /srv/openapp-data/postgres/init /srv/openapp-data/frontend/nginx/logs
sudo install -d -o 10001 -g 10001 /srv/openapp-data/openapp
cd core
docker compose --env-file .env up -d --no-build --wait postgres portal-backend frontend
bash bootstrap-admin.sh
```

组合包的持久制品子目录由 OPENAPP_RELEASE_PATH 决定，不一定是 openapp；应创建 `/srv/openapp-data/<OPENAPP_RELEASE_PATH>` 并赋予 UID/GID 10001 权限。启用 Adapter 的组合还需要启动 docker-socket-proxy 服务。后端证书包直接来自官方 Docker CLI 基础镜像，不再通过 apt 安装；DEBIAN_MIRROR 不影响该控制面镜像。

脚本交互式询问初始超级管理员邮箱和密码，密码不会回显。非交互安装可由秘密管理工具提供 OPENAPP_BOOTSTRAP_SUPER_ADMIN_EMAIL 与 OPENAPP_BOOTSTRAP_SUPER_ADMIN_PASSWORD；不要保存到 Git 或发布包。数据库 schema 在后端启动时初始化。任何超级管理员已存在时 bootstrap 都会拒绝执行，不会重置密码。后续账号管理使用经过授权的管理接口。

默认本地入口为 `http://127.0.0.1:14310/control`。纯 Core 不加载任何应用，也不启动 Docker Socket Proxy。公网使用前需配置 TLS、域名与安全 Cookie；仅启动上述三个服务不会自动开放公网网关。

导出的容器名默认包含 COMPOSE_PROJECT_NAME。同一主机可运行多个互不相撞的项目。迁移旧部署时，可用 OPENAPP_POSTGRES_CONTAINER、OPENAPP_PORTAL_BACKEND_CONTAINER、OPENAPP_FRONTEND_CONTAINER、OPENAPP_DOCKER_SOCKET_PROXY_CONTAINER、OPENAPP_GATEWAY_CONTAINER 显式保留已存在名称；先比较 `docker compose config`，确认服务身份和挂载不变。

自动验收：`npm run test:clean-install`。它在临时目录创建独立 Compose 项目和空数据库，验证首次初始化、重复初始化拒绝、登录权限、两次迁移及重启；完成后仅清理自己创建的资源。需要可用的 Docker、基础镜像仓库与 npm 网络访问。
