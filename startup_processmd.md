# OpenApp 开发与启动

本文档描述本项目的本地开发启动方式。以下命令均从仓库根目录执行。

## 1. 环境要求

- Node.js 24 LTS
- npm
- Docker Desktop、OrbStack 或 Linux Docker Engine
- PostgreSQL（推荐使用项目提供的 Compose 文件）

macOS 使用 OrbStack 时，确认 `docker` 命令可用；Linux 使用 Docker Engine。

```bash
docker version
docker compose version
node --version
npm --version
```

## 2. 安装依赖

在项目根目录执行：

```bash
npm ci
npm run build:contracts
npm --prefix backend install
npm --prefix frontend install
npm --prefix backend/runtime install
npm --prefix examples/plain-web run build
```

## 3. 创建本地配置

```bash
cp .env.example .env.local
```

编辑 `.env.local`，至少配置：

```dotenv
DATABASE_URL=postgres://container_service:本地数据库密码@127.0.0.1:25433/container_service
OPENAPP_ADMIN_CLI_TOKEN=仅保存在本机的管理员CLI令牌
```

默认 AUTH_PROVIDER=none，不加载外部账号实现。需要外部认证时，在本机配置已构建 Adapter 的绝对模块路径、允许根目录和 Provider ID；不要把容器内 /app 路径用于 local Profile。

运行应用时，先把 .env.local 中两个 /absolute/path/to/openapp 占位路径替换为本机仓库路径，并显式加载 App Adapter；示例 plain-web 不提供第三方登录或业务镜像。仅查看已有平台数据可设置 OPENAPP_CONTROL_PLANE_ONLY=true、AUTH_PROVIDER=none、OPENAPP_COMPATIBILITY_MODE=false，清空 Adapter module/catalog 配置；此模式不要求 Adapter，也不执行工作负载变更。

不要把本地环境文件、数据库密码、管理员令牌或外部凭据提交到 Git。

## 4. Profile

编辑 `config/openapp.config.json`：

```json
{
  "channel": "dev",
  "deployment": "local",
  "runtime": "docker"
}
```

字段含义：

- `channel=dev`：后端使用 `tsx`，前端使用 Vite 热更新。
- `channel=stable`：先构建，再运行 `dist` 和前端构建产物。
- `deployment=local`：Portal 在宿主机运行，PostgreSQL 由 Compose 运行。
- `deployment=container`：Portal 和 PostgreSQL 均由 Compose 运行。
- `runtime=orbstack`：macOS OrbStack；Linux 通常使用 `docker`。

查看解析后的配置：

```bash
npm run openapp:config
```

## 5. 推荐启动方式

统一启动前后端和本地 PostgreSQL：

```bash
npm run openapp:start
```

默认 `dev + local` 地址：

- 前端：`http://127.0.0.1:4174/`
- Portal 后端：`http://127.0.0.1:14313/`
- PostgreSQL：`127.0.0.1:25433`

停止由 Profile 管理的进程：

```bash
npm run openapp:stop
```

## 6. 分别启动前端和后端

需要分别调试时，打开两个终端。

终端一：

```bash
npm --prefix backend run dev
```

终端二：

```bash
npm --prefix frontend run dev -- --host 127.0.0.1 --port 4174
```

直接运行前，先启动 PostgreSQL，并在当前 shell 导出 `.env.local` 中的变量。

## 7. 构建与检查

```bash
npm --prefix backend run build
npm --prefix frontend run typecheck
npm --prefix frontend run build
npm --prefix backend test
```

后端测试会重新构建 Backend 和 Runtime。涉及 App 版本目录或镜像时，至少运行
后端完整测试和前端构建。

## 8. App 版本开发流程

实例镜像不再由“实例策略默认镜像”决定。创建实例时，服务端按以下链路选择镜像：

```text
默认 App -> App 激活版本 -> 版本关联的不可变镜像 -> 实例镜像快照
```

开发新 App 或新版本时：

1. 在管理员页面创建 App。
2. 选择 BuildStrategy，按它声明的槽位分别上传 BuildPackage。
3. 用 package ID 创建 AppVersion，并显式发起 ImageBuild。
4. 构建成功后从 ImageArtifact 列表选择产物，显式绑定到版本。
5. 激活 AppVersion，再将实例策略中的默认 App 设置为目标 App。

ImageBuild 只创建不可变 ImageArtifact，不会隐式绑定或激活 AppVersion。上传过的
BuildPackage 可以用于多个版本或多次构建，因此构建失败不需要重复上传原文件。

也支持直接 pull/load 已构建镜像，无需先上传构建包。镜像经过验证后作为独立来源的制品关联 App Revision，并显式激活；可用于日常镜像分发或恢复。CLI 示例：

```bash
node backend/dist/cli.js --identity admin images pull example/app:dev
node backend/dist/cli.js --identity admin images load ./app-image.tar example/app:dev
```

## 9. 常见问题

### 端口被占用

检查 `4174`、`14313` 和 `25433` 的占用进程，或修改 Profile 中的端口配置。

### `state_locked` 或进程状态残留

这是本地状态文件被另一个 OpenApp 进程持有。先执行：

```bash
npm run openapp:stop
```

确认没有正在运行的 Portal 后，再重新执行 `npm run openapp:start`。不要在有活动
实例操作时强行删除状态文件。

### 容器创建失败

先检查 Docker/OrbStack：

```bash
docker version
docker images
```

再确认默认 App 存在激活版本，且该版本已关联当前运行时中存在的不可变镜像。

### 修改 CPU、内存或进程数后没有变化

这些是单实例资源限制。保存策略后，已有实例必须执行重建；App 版本、镜像和持久
Volume 不会因此被替换。
