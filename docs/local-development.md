# 本地开发与测试

[文档中心](README.md) · [贡献指南](../CONTRIBUTING.md)

## 准备依赖

使用 Node.js 24 LTS、npm 和 Docker Engine／OrbStack；PostgreSQL 17 是 CI 基线。在 Core 根目录执行：

```bash
npm ci
npm --prefix backend/runtime ci
npm --prefix backend ci
npm --prefix frontend ci
```

## 本地开发步骤

OpenApp 使用三个独立配置项选择运行方式：

```json
{
  "channel": "dev",
  "deployment": "local",
  "runtime": "docker"
}
```

编辑 [`config/openapp.config.json`](../config/openapp.config.json)：

- `channel`：`dev` 使用源码与 Vite；`stable` 使用构建产物。
- `deployment`：`local` 在宿主机运行前后端并直连 OrbStack/Docker；`container` 使用 Compose 运行 Portal。
- `runtime`：macOS OrbStack 使用 `orbstack`；Linux Docker Engine 使用 `docker`。

敏感配置不进入 Profile。先创建本机环境文件，再使用统一命令：

```bash
cp .env.example .env.local
# 完成上面的依赖安装后，构建中性示例
npm --prefix examples/plain-web run build
# 修改 .env.local 中的密码、令牌、发布目录与示例 Adapter 的绝对路径
npm run openapp:config
npm run openapp:start
# 另一个终端停止 Profile 管理的进程
npm run openapp:stop
```

`dev + local` 的前端地址是 `http://127.0.0.1:4174/`，后端地址是
`http://127.0.0.1:14313/`。local Profile 使用 Compose 只管理 PostgreSQL，
并通过 `127.0.0.1:25433` 提供给本机后端；Portal 本身不在容器中运行。

## 构建与验收

```bash
npm --prefix backend run build
npm --prefix frontend run typecheck
npm --prefix frontend run build
```

里程碑自动验收使用根目录脚本。快速模式只运行隔离的合同测试；完整模式还运行全量回归、
PostgreSQL 17 integration 和可丢弃 Docker Storage 测试：

```bash
npm run test:acceptance
POSTGRES_TEST_URL=postgres://... \
  OPENAPP_RUNTIME_ACCEPTANCE_IMAGE=sha256:... \
  npm run test:acceptance:full
```

完整模式不会把 `DATABASE_URL` 当测试库；必须显式提供可丢弃的 `POSTGRES_TEST_URL`。Storage
测试创建随机 `oa-accept-*` 资源，部署回归还会创建使用 tmpfs 的
`openapp-postgres-init-test-*` 临时容器；两者结束时都会清理。仍应确认当前
`DOCKER_CONTEXT`/`DOCKER_HOST` 指向测试 Engine，不能对生产 Docker 主机执行。

未配置 `DATABASE_URL` 时后端使用仅用于开发的内存存储；生产部署必须使用 PostgreSQL。OpenApp 本地邮箱密码账号始终可用，密码以带随机盐的 scrypt hash 保存；外部账号登录由已审核的 Auth Provider Adapter 配置，通用默认值为 `AUTH_PROVIDER=none`。

外部 Provider 的 challenge 只证明身份，不直接授予管理权限；协议由 Adapter 声明，
不由 Core 根据 App 名称推断。新 SSO 账号始终创建为普通成员；OpenApp 数据库中的 `admin` 与 `super_admin` 都可进入
管理工作台。管理员可创建成员账号并执行运维操作，但只能查看角色；超级管理员才
能创建管理账号或修改他人角色，且不能修改自己的角色。首次部署通过 PostgreSQL
引导唯一的初始超级管理员；晋升仅有 SSO 身份的账号时，管理页会先要求设置本地
密码，取消设置不会改变角色。

后端同时提供 `openappctl` CLI：管理员可查看和管理用户、实例、运行时、镜像和转发策略；普通用户使用自己的 Portal Session，只能查看和操作自己的实例。CLI 详细命令与部署环境变量见 [`backend/README.md`](../backend/README.md)。
