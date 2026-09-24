# 从现有 Web 应用到双用户独立部署

本教程从一个不认识 OpenApp 的单人笔记应用开始：前端读写笔记，后端将笔记存入文件。
你将创建独立应用仓库和 Adapter 仓库，把 Adapter 与 Core 组合编译，在新数据库上启动，
最后用两个普通账号验证独立访问和重启持久性。应用代码不增加用户或租户判断。

第一次请完整跑通原样示例，再按第 8 节替换自己的应用。这里是**本机全新安装**，
不是线上更新教程；不会使用已有部署的 `.env`、数据库或 Volume。

自动重放会保存本次实验的验收结果；使用自己的业务时须重新验证，不能沿用示例结论。

## 0. 准备与目录

需要 Node.js 24 LTS、npm、Git，以及可用的 Linux Docker Engine（macOS 可使用 OrbStack）
和 Docker Compose v2。Linux 用户需有 Docker 权限。镜像仓库和 npm 必须可访问。
示例通过本机回环地址访问；第一次不要使用远程 Docker context。

在已检出的 **OpenApp Core 根目录**打开终端，后续命令使用同一个终端：

```bash
export CORE_ROOT="$PWD"
export LAB_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/openapp-tutorial.XXXXXX")"
export TARGET_PLATFORM="$(docker version --format '{{.Server.Os}}/{{.Server.Arch}}')"
node --version
docker compose version
printf '实验目录：%s\n运行平台：%s\n' "$LAB_ROOT" "$TARGET_PLATFORM"
```

`TARGET_PLATFORM` 应为 `linux/amd64` 或 `linux/arm64`，应用镜像和控制面镜像使用相同平台。
`LAB_ROOT` 是新建目录，记录下来；如果换终端，重新设置这三个变量。

最终目录及归属如下：

```text
Core 检出目录/              通用平台源码，CORE_ROOT 指向这里
实验目录/                   LAB_ROOT 指向这里
├── notes-app/              新的应用 Git 仓库：业务前端、后端、Dockerfile
├── notes-adapter/          新的 Adapter Git 仓库：公开合同、运行声明、组合配置
├── sdk/                    编译好的公开 SDK 包和校验和
├── release/                生成的控制面部署包，不是新的源码仓库
├── data/                   本次实验专用 PostgreSQL、日志和制品目录
└── tutorial-*.json          本地配置摘要、私密测试账号和验收结果
```

安装 Core 的编译依赖。已有锁文件使用 `npm ci`：

```bash
# tutorial:dependencies
cd "$CORE_ROOT"
npm ci
npm --prefix backend/runtime ci
npm --prefix backend ci
npm --prefix frontend ci
```

## 1. 创建两个新的独立仓库

```bash
# tutorial:copy
cd "$CORE_ROOT"
cp -R examples/notes-app "$LAB_ROOT/notes-app"
cp -R examples/notes-adapter "$LAB_ROOT/notes-adapter"
cp LICENSE "$LAB_ROOT/notes-app/LICENSE"
cp LICENSE "$LAB_ROOT/notes-adapter/LICENSE"
git -C "$LAB_ROOT/notes-app" init
git -C "$LAB_ROOT/notes-adapter" init
```

检查应用：`notes-app/frontend/` 包含 HTML、JavaScript、CSS，
`notes-app/backend/server.mjs` 提供网页、`GET/PUT /api/note` 和 `GET /health`。
Dockerfile 把前端和后端装进同一个运行镜像，后端在 8080 端口提供两者，
数据写入 `/data/note.json`，容器以 `node` 用户运行。

**当前 Core 的默认应用入口是 `/instances/<id>/ui/`，代理只去掉 `/instances/<id>`，
业务后端收到的是 `/ui/`。** 本例后端支持普通部署配置 `BASE_PATH`，Dockerfile 设置
`BASE_PATH=/ui`，所以镜像提供 `/ui/`、`/ui/api/note`；健康接口仍是 `/health`。
直接运行后端时未设置 BASE_PATH，仍可使用根路径。这是部署路径配置，不是新增多租户业务逻辑。

前端请求 `./api/note`，资源使用 `./app.js`、`./style.css`，可随页面路径变化。
仅改前端相对路径还不够，后端也必须能在 `/ui/` 提供页面与对应 API。
`/api/note` 这样的根绝对路径会访问 OpenApp 的根 API，不能直接照搬。
应用没有认证能力，只能通过平台代理开放访问。

## 2. 安装公开 SDK，编译 Adapter

为避免假设 npm 上已经有指定版本，教程从当前 Core 生成 SDK tarball，然后在新仓库中
安装这个包。Adapter 不导入 Core 源码，不使用兄弟目录链接。

```bash
# tutorial:sdk
cd "$CORE_ROOT"
npm run release:sdk -- "$LAB_ROOT/sdk"
cd "$LAB_ROOT/sdk"
shasum -a 256 -c SHA256SUMS
cd "$LAB_ROOT/notes-adapter"
npm install --save-dev "$LAB_ROOT/sdk/openapp-contracts-0.2.0.tgz"
npm test
```

预期：校验显示 `OK`，测试通过，生成 `package-lock.json`、`dist/index.js` 和
`dist/profile.json`。这是一个尚无锁文件的新项目，所以首次使用 `npm install`；
之后用 `npm ci`。团队共享时将本地 tarball 换成固定版本的 release URL 或已发布 npm
版本，重新生成并提交锁文件；不要把自己的临时路径交给其他开发者。

打开 `notes-adapter/src/index.ts`，逐项对照声明：

| 位置                                               | 示例值及作用                                            |
| -------------------------------------------------- | ------------------------------------------------------- |
| `manifest.id`、`entry.id`、`authHandoff.appId`     | 都为 `notes-demo`，绑定同一个应用                       |
| `manifest.version`、package.json、组合配置 version | 都为 `1.0.0`，导出器检查一致性                          |
| `auth.providerId` / protocol                       | `none`：无外部 SSO；用户仍需 OpenApp 本地账号登录       |
| `workload.runtime`                                 | 从 profile 读取应用镜像的启动与存储合同                 |
| `catalogBootstrap`                                 | 在空平台数据库中登记示例应用及初始镜像                  |
| `authHandoff`                                      | 不转发平台 Cookie，不接受外部凭证，应用仅由平台代理保护 |

`src/profile.json` 与应用 Dockerfile 必须对应：

| Profile 字段         | 本例值                                           | 修改自己的应用时检查                       |
| -------------------- | ------------------------------------------------ | ------------------------------------------ |
| defaultImage         | `openapp-notes-demo:1.0.0`                       | 目标 Docker Engine 上实际可用的镜像        |
| containerPort        | `8080`                                           | 服务监听 `0.0.0.0`，不是仅监听容器回环地址 |
| containerUser        | `node`                                           | 与 Dockerfile 的 USER 一致                 |
| entrypoint / command | `/app/start.sh` / `node /app/backend/server.mjs` | 与镜像 Entrypoint 和 Cmd 精确一致          |
| healthPath           | `/health`                                        | 启动后返回成功状态                         |
| storageMountPath     | `/data`                                          | 应用实际写入的目录，非 root 用户有写权限   |
| contract             | `notes-demo-v1`                                  | 与 workload 和初始目录声明一致             |

本例使用现成镜像，故没有 `buildStrategy`、上传槽位或 Adapter `runtime/` 构建目录。
`src/profile.json` 是运行声明，业务 Dockerfile 由应用仓库维护。只需这些能力即可运行，
不必实现 SSO、自定义登录页面、legacy 或数据库迁移。

## 3. 构建业务镜像

```bash
# tutorial:app-image
cd "$LAB_ROOT/notes-app"
docker build --platform "$TARGET_PLATFORM" -t openapp-notes-demo:1.0.0 .
docker image inspect openapp-notes-demo:1.0.0 --format '{{.Os}}/{{.Architecture}} {{json .Config.Entrypoint}} {{json .Config.Cmd}}'
```

预期输出的平台与第 0 步一致，Entrypoint 为 `/app/start.sh`，Cmd 为上述 node 命令。
这个镜像承载**用户笔记应用**；后面构建的两个镜像承载 **OpenApp 管理前后端**，用途不同。

## 4. 组合编译控制面部署包

`notes-adapter/openapp.release.json` 已声明 `notes-demo` 插件，`source: "."`
相对清单所在目录解析。运行命令的位置仍是 Core：

```bash
# tutorial:compose
cd "$CORE_ROOT"
npm run release:openapp -- "$LAB_ROOT/notes-adapter/openapp.release.json" "$LAB_ROOT/release"
node "$LAB_ROOT/release/verify.mjs"
```

预期输出 `openapp-control-plane verified`。导出器重新编译 Core 和 Adapter，验证注册信息，
并生成 `release/core/`、`release/openapp-notes-demo-adapter/`、镜像构建脚本及指纹。
应用业务前后端仍在业务镜像中；组合包不会重新编译或暗中修改它们。

每次导出使用**不存在的新目录**。源码变更后应重新导出，不手改生成包。
本次新仓库未提交，因此是 development 导出；正式发布须提交并清理各源码仓库后
使用 `--official`，不能把本教程的开发包称作已签名正式版本。

## 5. 配置并启动组合部署

先构建 OpenApp 后端与前端镜像，并准备独立健康探针镜像：

```bash
# tutorial:control-images
cd "$LAB_ROOT/release"
bash build-images.sh
docker pull --platform "$TARGET_PLATFORM" node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
```

预期得到 `openapp-portal-backend:release-<指纹>` 和 `openapp-frontend:release-<指纹>`。
随后使用教程配置助手，避免漏填镜像名、来源地址或数据目录：

```bash
# tutorial:configure
cd "$CORE_ROOT"
node scripts/tutorial/configure.mjs "$LAB_ROOT/release" "$LAB_ROOT/data"
```

助手只接受新的数据目录和不存在的 `core/.env`。它生成随机数据库密码和 CLI 令牌，
创建本次专用目录，为制品目录设置 UID/GID 10001，读取 Docker Socket GID，选择空闲本地
端口，并写入配置。**不会修改已有部署**。记下输出的用户入口和 `/control` 地址。
运行资源使用短随机 `oat-…` 前缀：容器名称追加 UUID 后仍需满足 DNS 单标签不超过
63 字符的要求，不能直接使用很长的项目路径或名称作为实例前缀。

打开 `release/core/.env`，对照以下关键项。密码不要贴进 issue 或提交到 Git：

| 配置                                       | 应有状态                                        |
| ------------------------------------------ | ----------------------------------------------- |
| COMPOSE_PROJECT_NAME                       | 本次随机 `openapp-tutorial-…`，不与已有服务重名 |
| 各运行资源前缀                             | 本次短随机 `oat-…` 前缀，容器全名不超过 63 字符 |
| OPENAPP_DATA_ROOT                          | 本次 `LAB_ROOT/data` 的绝对路径                 |
| OPENAPP_CONTROL_PLANE_ONLY                 | `false`；组合包需要执行应用工作负载             |
| OPENAPP_ADAPTER_CATALOG                    | `/app/backend/plugins.json`，由导出器生成       |
| OPENAPP_RELEASE_PATH                       | `notes-demo`，对应数据目录中的制品子目录        |
| AUTH_PROVIDER / OPENAPP_COMPATIBILITY_MODE | `none` / `false`                                |
| BACKEND_IMAGE / FRONTEND_IMAGE             | 第 5 步生成的两个指纹镜像                       |
| TARGET_PLATFORM                            | 与业务镜像一致                                  |
| PUBLIC_ORIGIN / PORTAL_PUBLIC_BASE_URL     | 同一个本地入口，含正确端口                      |

启动数据库、Socket Proxy、后端和前端；这里**不使用纯 Core 三服务命令**：

```bash
# tutorial:start
cd "$LAB_ROOT/release/core"
docker compose --env-file .env config --quiet
docker compose --env-file .env up -d --no-build --wait --wait-timeout 120 postgres docker-socket-proxy portal-backend frontend
docker compose --env-file .env ps
```

预期四个服务启动，健康检查通过。最后初始化管理员：

```bash
# tutorial:bootstrap
cd "$LAB_ROOT/release/core"
bash bootstrap-admin.sh
```

交互输入你自己的管理员邮箱和密码。超级管理员已存在时脚本会拒绝再次初始化。
自动验收时由秘密环境变量注入随机测试密码，不会使用真实账号。

## 6. 一项一项验收

先自动验证。脚本读取本次实验标记，只接受本机教程环境，拒绝重复创建测试账号：

```bash
# tutorial:verify
cd "$CORE_ROOT"
node scripts/tutorial/verify.mjs "$LAB_ROOT/release"
node "$LAB_ROOT/release/verify.mjs"
```

应看到以下全部 `PASS`，然后在 `LAB_ROOT/tutorial-acceptance.json` 找到结果：

1. 管理页面和就绪接口正常；没有外部 SSO，本地账号可用。
2. 新建 Alice、Bob 两个普通账号，创建两个真实应用实例。
3. 前端 HTML/JS/CSS 和笔记 API 正常；两个用户写入不同内容后互不覆盖。
4. 普通用户不能访问管理接口，不能读取或启动对方实例；未登录不能读取笔记。
5. 两个实例分别停止、再启动后，笔记仍存在。
6. OpenApp 后端重启后，仍可登录并读取原来的笔记。

测试账号随机密码保存在 `LAB_ROOT/tutorial-accounts.json`，文件权限为 0600，不打印到
日志、不放入部署包。用两个浏览器配置文件打开用户入口，分别用邮箱和密码登录这两个账号，自动进入应用，
确认不同笔记、编辑保存和刷新都正常。管理账号从 `/control` 登录可看到两个实例。

验收通过的是这个示例及本次部署，不等于已验证你的真实业务迁移、SSO 或外部数据库。

也可以自动执行浏览器验收（在第 6 步后执行一次；会把测试笔记改成新的中文内容）：

```bash
npm install --prefix "$LAB_ROOT/browser-tools" playwright@1.63.0
node "$LAB_ROOT/browser-tools/node_modules/playwright/cli.js" install chromium
node "$CORE_ROOT/scripts/tutorial/browser.mjs" "$LAB_ROOT/release"
```

它使用两个独立浏览器会话，实际点击登录、保存、刷新，检查笔记不串号和页面无异常。
截图与 `tutorial-browser.json` 放在实验目录，不进入部署包。Linux 若缺浏览器系统依赖，
按 Playwright 提示安装依赖后再运行。

### 一键重放文档

维护者可以在 Core 执行 `npm run test:tutorial -- --lang=zh-CN`。它会新建实验目录，逐段提取并执行本文
带 `tutorial:` 标记的原始命令，校验业务源文件未被改动，成功或失败后均限定清理本次服务。
运行前会校验中英文教程的标记命令一致；默认和 CI 重放英文教程。自动验收不会运行上面的可选浏览器步骤。想继续浏览器验收可用
`npm run test:tutorial -- --keep-running`，完成后按第 7 节停止。
成功记录为 `tutorial-progress.json` 的 `status: passed` 和 `tutorial-acceptance.json`；
任何失败都会以非零状态退出，不能把“编译成功”当成“运行通过”。

## 7. 停止实验、部署到另一台服务器

需要保留数据时，运行限定到本次实验身份的清理助手：

```bash
cd "$CORE_ROOT"
node scripts/tutorial/stop.mjs "$LAB_ROOT/release"
```

助手先停止本次动态创建的用户实例，再移除本次四个控制面容器和网络，释放网络地址池。
不删除数据库目录或用户 Volume；重新执行第 5 节的启动命令即可恢复控制面。
Compose 自身**不会自动停止 OpenApp 动态创建的用户实例**。
不要使用全局 prune。数据库在 `LAB_ROOT/data`，用户笔记在各自的 Docker Volume，
目录里的 `tutorial-state.json` 记录本次项目身份。

在另一台服务器全新安装时：传输已验证的 `release/`；另行推送/传输业务镜像，
确保目标 Docker Engine 能取得与 profile 对应的镜像及平台；按第 5 步选择自己的域名、
密码、数据目录、Socket GID 和端口再启动。教程配置助手仅用于本机实验，不用于公网配置。
公网还需要 TLS、安全 Cookie 和网关配置，见[部署参考](plugin-catalog-release.md)。
迁移已有数据另按[备份恢复手册](operations/backup-restore-runbook.md)执行。

## 8. 换成自己的 Web 前后端

| 你的项目情况                     | 需要处理                                                                                                                               |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 后端可以提供构建后的前端静态文件 | 参考本例，把前端 dist 和后端放进同一个运行镜像                                                                                         |
| 前端开发时使用 Vite 等独立服务   | 生产先构建静态文件；不要直接把开发服务器当生产运行方式                                                                                 |
| 前后端必须是独立服务/多个容器    | 当前 Docker Runtime 以一个工作区一个应用容器、一个 HTTP 入口为基本模型；本教程不能直接编排任意业务 Compose，需单独设计受支持的运行接入 |
| 前端使用根绝对路径或硬编码域名   | 配置静态资源 base 和 API base，使它们经过实例入口；不要把对业务路径的必要适配说成零改动                                                |
| 使用外部数据库或对象存储         | 为实例配置独立数据边界与凭据；单独数据卷不会隔离共享的外部服务                                                                         |
| 只需要 OpenApp 登录              | 保留本例的 `none` 与无凭证交接，应用不公开容器端口                                                                                     |
| 应用还需要自己的登录/SSO         | 增加 authProvider/authHandoff，验证 Cookie 范围和撤销；见[后端能力](adapter-backend.md)                                                |
| 需要品牌登录页或管理员 SSO 视图  | 增加 assets/authUi；见[UI 协议](adapter-ui.md)，不改 Core 的平台品牌区域                                                               |
| 想在管理页上传制品并构建镜像     | 再增加 buildStrategy、包槽位与构建材料；现成镜像接入不用实现它们                                                                       |

替换时统一修改 App ID、镜像、运行合同、端口、启动命令及存储路径，重新编译组合，
再重复第 6 步；不要只改显示名称就认定已适配。后续更新应用镜像需要导入候选、验证、
激活并显式升级已有实例；`catalogBootstrap` 仅帮助首次初始化，不是升级机制。

## 常见问题

| 现象                                                   | 检查与下一步                                                                         |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| npm 提示 contracts 404                                 | 先按第 2 步安装本次 SDK tarball，不假定 registry 已公开                              |
| 组合提示 ID/版本不匹配                                 | 对照 manifest、package.json 和 release.json；source 相对清单文件                     |
| 页面只提示没有 Adapter                                 | 是否误用 `config/core.release.json`；重新导出 Notes 组合，不能只切换环境变量补出插件 |
| Runtime 不可用                                         | Socket Proxy 是否健康、DOCKER_GID 是否正确、目标 Docker Engine 是否可访问            |
| all predefined address pools have been fully subnetted | Docker 本机网络地址池耗尽；先按第 7 节清理自己的旧实验，不要全局清理其他部署         |
| runtime_image_platform_invalid                         | 比较镜像 inspect 输出与 TARGET_PLATFORM，并为正确平台重建                            |
| 页面能打开但 API 或资源 404                            | 检查实例 URL 尾部 `/`、资源相对路径和 API base                                       |
| origin_not_allowed                                     | PUBLIC_ORIGIN 与浏览器实际地址必须一致；localhost 与 127.0.0.1 是不同来源            |
| verify 报多余文件                                      | 只允许本地 `core/.env` 例外；日志、账号与数据放到 release 外，不手改生成代码         |

需要查字段或扩展点时，再读[完整开发参考](adapter-development.md)。术语中 Core 是通用
平台、Adapter 是集成、业务镜像是用户实际运行的应用、组合包是匹配版本的控制面交付物。
Revision 是平台记录的不可变应用发布快照，不等于 Git commit 或 Adapter 版本。
