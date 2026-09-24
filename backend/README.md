# Container Control Plane

OpenApp 的 Node.js/TypeScript 通用控制面，负责登录、用户/管理员会话、Tenant/Workspace
隔离、App 目录校验、实例生命周期、访问转发、持久存储和发布编排。业务前端只访问本
服务的 `/api`；App 业务页面运行在独立 Environment 中，不编译进 Portal。

下游 App 的免登录由代码注册的 `AppAuthHandoff` 适配器负责。Portal 路由不识别
具体 App 的 Cookie 名称或 Provider token。新增 App 时只需在其独立 Adapter 中实现
公开合同并在组合根按 allowlist 装载；数据库和前端请求不能动态声明凭证转发规则。
未注册适配器的 App 只能使用代码固定的 credential-free 行为，不能凭数据库字段获得
Cookie/token 转发能力。产品兼容实现由外部 Adapter 拥有。

## 启动

在仓库根目录安装依赖并启动：

```bash
npm ci
npm --prefix backend/runtime ci
npm --prefix backend ci
npm --prefix frontend ci
npm --prefix backend run build
npm --prefix examples/plain-web run build
cp .env.example .env.local
# 修改 .env.local 中的数据库密码、令牌与绝对路径，再启动。
npm run openapp:start
```

即使不使用外部 SSO，也必须显式加载至少一个 App 插件。示例配置使用中性的
`plain-web`：将 `OPENAPP_ADAPTER_MODULE` 设置为本仓库
`examples/plain-web/dist/index.js` 的绝对路径，`OPENAPP_ADAPTER_ALLOWED_ROOTS`
设置为 `examples/plain-web` 的绝对路径，保留 `AUTH_PROVIDER=none`。
示例可验证控制面与本地账号；发布真实业务 Revision 前不能启动业务实例。
详见 [本地开发](../README.md) 与 [示例说明](../examples/plain-web/README.md)。

未设置 `DATABASE_URL` 时使用内存存储，仅便于本地冒烟；部署必须配置 PostgreSQL。首次启动自动创建 `users`、`auth_identities`、`local_credentials`、`sessions`、`containers` 等表，也可运行 `npm run migrate`。
涉及 PostgreSQL 迁移或引用并发的改动，应使用 PostgreSQL 17 测试库执行
`POSTGRES_TEST_URL=postgres://... npm run test:postgres`；测试会创建独立 schema，
验证迁移幂等以及清理与 Revision/ImageBuild 并发时不会留下悬空 package ID。

`CONTAINER_RUNTIME=docker`（Linux）或 `CONTAINER_RUNTIME=orbstack`（macOS）选择底层运行时。两者都调用 Docker-compatible CLI；OrbStack 通过 `DOCKER_CONTEXT`/`DOCKER_HOST` 选择 Engine，不调用 `orb run`。`CONTAINER_RUNTIME_ENDPOINT_MODE=loopback` 用于宿主机后端，`network` 用于容器后端。仓库根目录的 `config/openapp.config.json` 和 `npm run openapp:start` 负责选择并启动这两种部署方式。

实例的 private/egress 网络不再消耗 Docker 默认地址池。`OPENAPP_NETWORK_POOL_CIDR`
默认 `10.240.0.0/12`，`OPENAPP_NETWORK_SUBNET_PREFIX` 默认 `28`；每个实例使用两个
显式小子网，候选冲突时 Runtime 会自动探测下一段。部署前应确认专用池不与宿主机、
VPC、VPN 或 Kubernetes 路由重叠。

## API

- `POST /api/auth/local/register` `{email,password}`：创建普通 OpenApp 本地账号
- `POST /api/auth/local/login` `{email,password}`：本地账号登录
- `POST /api/auth/local/admin-login` `{email,password}`：仅为本地管理员签发管理 Session
- `POST /api/auth/external/<provider>/email-codes` `{email}`：向已注册外部身份 Provider 请求 challenge
- `POST /api/auth/external/<provider>/login` `{email,code,providerData?}`：验证外部账号并创建普通用户 Session
- `GET /api/auth/methods`：读取前端可展示的本地和外部登录方式
- `GET /api/apps`：普通用户读取已有当前 Revision 且可启动的 App（不会返回发布包路径或哈希）
- `GET /api/admin/apps`：管理员读取 App 目录及内部 Revision 元数据
- `POST/PATCH /api/admin/apps`、`/api/admin/apps/:id`：创建、启用或归档 App
- `GET/POST /api/admin/build-packages`：按 BuildStrategy 单个槽位上传或复用不可变包
- `DELETE /api/admin/build-packages/:id`：仅在 Revision 与 ImageBuild 均未引用时删除包
- `GET /api/admin/build-strategies`：读取代码支持的策略 revision 与包槽位
- `POST /api/admin/apps/:id/image-updates`：继承当前包、替换指定槽位并构建烟测候选
- `POST /api/admin/apps/:id/image-updates/:revisionId/bind`：带 expectedRevision 将候选设为当前
- `GET/POST /api/admin/image-builds`：查看或创建独立镜像构建
- `GET /api/admin/image-artifacts`：读取成功构建产生的不可变产物
- `DELETE /api/admin/image-artifacts/:id`：仅在 Revision 与 Container 均未引用时删除产物
- `GET /api/admin/resource-cleanup?keepPrevious=1`：预览保留回滚候选后的安全清理结果
- `POST /api/admin/resource-cleanup` `{keepPrevious:1}`：归档保留范围外且无 Container 引用的旧 Revision，并释放不再被引用的包与镜像资源
- `/api/admin/apps/:id/versions/**`：旧版本创建、构建、artifact 与 activate 兼容接口
- `GET /api/auth/me`、`POST /api/auth/logout`
- `POST /api/admin/users` `{email,password,role}`：管理员可创建带本地密码的成员；超级管理员还可创建管理员或超级管理员
- `PATCH /api/admin/users/:id-or-email/role` `{expectedRole,role,password?}`：仅超级管理员可调整他人角色；晋升缺少本地凭据的账号时需同时提交符合策略的初始密码
- `POST /api/containers`：按服务端实例策略为当前用户创建 App Environment；`appId` 必须是当前公开目录中的已激活 App，并由服务端校验其 Runtime、Provider 和凭证适配器
- `GET /api/containers`：普通用户仅能看到自己的记录，管理员可看到全部
- `POST /api/containers/:id/start|stop|enter`、`DELETE /api/containers/:id`
- `POST /api/admin/containers/:id/rebuild`：保留当前快照；`{useLatestVersion:true}` 显式升级到 App 当前 Revision

实例策略由管理员统一配置：

- `GET/PATCH /api/admin/instance-policy`：首次访问自动创建、默认 App、总量/运行中上限、进入自动启动、请求自动唤醒、手动停止唤醒保护、闲置停止分钟数、CPU/内存/PID、环境变量和启动配置文件模板
- `POST /api/containers/ensure-default`：按策略处理当前用户的首次访问；容量不足、已关闭或已完成初始化时返回稳定 `reason`
- `POST /api/admin/maintenance/sweep`：提交一次闲置回收任务，返回 `202 + operationId`；服务自身每 30 秒执行同一回收逻辑

策略更新不会自动重建已有实例；镜像、环境变量和启动配置模板只影响新实例，App Revision 在实例创建时固定。普通 rebuild 只应用当前 CPU、内存和进程数限制；只有 `useLatestVersion=true` 或 `openappctl containers upgrade` 才切换到 App 当前镜像，并继续复用原 Volume。配置文件模板写入新 Volume 的第一次启动并由 marker 防止重启覆盖；删除实例是显式操作，删除后不会因刷新页面再次自动创建，但用户仍可手动创建。容量预留使用 PostgreSQL advisory lock（无数据库的本地内存模式只适合开发），并在进程内对同一用户/实例做 single-flight。

实例因空闲策略停止时记录 `stopReason=idle`。开启默认的 `autoWakeOnRequest` 后，下一次 HTTP 或 WebSocket 请求会在 Portal 中等待实例启动和健康检查，然后继续转发；并发请求共享一次唤醒。用户或管理员主动停止分别记录 `manual_user`、`manual_admin`，默认开启的 `blockAutoWakeAfterManualStop` 会阻止后台请求重新拉起，只有明确的启动或进入操作会清除停止原因。异常退出记录 `failure`，不会自动循环启动。

管理员还可以通过 `/api/admin/overview`、`/api/admin/users`、
`/api/admin/containers`、`/api/admin/runtime`、`/api/admin/images` 和
`/api/admin/forwarding` 查看和管理全局资源。角色更新使用
`PATCH /api/admin/users/:id-or-email/role`，镜像归档使用原始 tar 请求体；
导入时提供的镜像引用会实际通过 runtime 打标签。

部署级配置（数据库连接、外部 Provider 地址、运行时选择、静态/发布目录和 Cookie 安全属性）由环境变量或 Profile 文件管理；管理台只读展示当前值和需要重启的项目，不提供在线改写密钥或进程启动参数的入口。实例策略、转发策略、镜像/发布操作和闲置维护属于受控的管理台热更新范围。

`POST /api/admin/build-packages` 一次上传一个策略槽位，成功后返回可复用的 package
ID。image update 只提交要替换的 `slot -> package ID`，其余槽位从当前 Revision
继承；服务端创建 Revision、ImageBuild 并完成运行时烟测，但不会自动设为当前。
管理员检查候选后再用 expectedRevision bind。兼容 multipart 版本接口保留，但不再是
日常入口。策略切换和候选构建都不会升级已有实例。

## App 目录、Revision 与镜像

App 目录、构建域和镜像产物彼此独立：`apps` 保存稳定身份、显示信息和认证适配器；
`build_strategies` 声明槽位与 Runtime 合同；`build_packages` 保存上传包的相对路径、
哈希及各自 source version/build ID；`app_versions` 作为兼容表名保存每个 App 单调递增
的内部 Revision；`image_builds` 冻结一次构建的策略 revision 与 package ID/hash；
`image_artifacts` 保存烟测成功后的不可变镜像 ID。BuildPackage 位于
`<OPENAPP_RELEASE_DIR>/build-packages/<package-id>/`，Revision manifest 位于
`<OPENAPP_RELEASE_DIR>/apps/<app-id>/<revision-id>/`。实例把 `appVersionId`、
`imageArtifactId` 和 `imageReference` 三个快照写入 `containers`，切换 App 当前
Revision 不会改变已有实例。

Portal 镜像内的代码所有 adapter 负责构建；管理员只能选择 BuildStrategy 和
BuildPackage，不能上传 Dockerfile 或构建命令。ImageBuild 完成会检查镜像在当前
Docker/OrbStack 引擎中存在，把 tag 解析为不可变的 `sha256:<image-id>`，并只创建
ImageArtifact。产物绑定是之后的独立目录操作；运行时无法提供不可变 ID 时明确失败，
不会保存可变 tag。包身份、槽位、包内布局与组装规则由 BuildStrategy Adapter
校验和执行。Core 不默认提供某种语言的 Dockerfile、双包配方或启动命令。
Adapter 返回公开的 `buildStrategy` 实现，并使用 host 提供的制品能力；其脚本与
运行文件随 Adapter 发布。历史策略行只是元数据，只有匹配的实现已加载且当前模式
允许执行时才可构建。纯控制面模式保留历史展示并禁用上传和构建。
当前所有 App 与 Portal 共用同源实例代理，因此目录只接受管理员审核过的可信
应用包；不可信 App 需要独立域名/子域名隔离，尚未纳入此目录合同。

容器进入接口先检查 PostgreSQL 记录及归属，未创建或非本人不可进入。会话只放 HttpOnly Cookie，前端不传 `userId`。

OpenApp 本地账号使用邮箱密码，密码只保存为带随机盐的 scrypt hash。外部 Provider 的
邮箱验证码或其他 challenge 不采信 Provider 返回的角色；新 SSO 账号固定创建为普通成员。管理权限只读取
OpenApp 数据库中的 `admin` 或 `super_admin` 角色，因此两类管理账号都可以使用
本地密码或关联的 SSO Session 进入管理页。首次部署必须直接在 PostgreSQL 中引导
初始超级管理员；管理员可创建成员账号但角色只读，只有超级管理员能创建管理账号
或调整他人角色。超级管理员不能修改自己的角色，系统始终保留至少一个超级管理员。
目标账号没有本地密码时，管理页会先提示设置初始密码，设置成功后才继续晋升；取消
不会改变原角色。CLI 管理令牌只有管理员权限，不提供角色变更命令。
具体引导命令见 [`deployment/README.md`](deployment/README.md)。

本地注册和密码登录在执行 scrypt 前按来源地址与标准化邮箱双重限流。默认使用直
接 Socket 地址；只有入口由可信反向代理独占、且代理会覆盖
`X-Forwarded-For` 时才设置 `PORTAL_TRUST_PROXY=true`。生产代理层仍应保留外层
限流。

验证码格式和注册条件由 Provider 验证。Core 仅传递不透明 providerData，默认表单按声明字段渲染；专用界面和挑战分支由 Adapter 提供，不能改变 Core 角色授权。

## `openappctl` 运维 CLI

构建 Backend 后可用 `node dist/cli.js`（安装 npm 包后命令名为 `openappctl`）调用 Portal API：

```bash
export OPENAPP_PORTAL_URL=https://portal.example.com
export OPENAPP_ADMIN_CLI_TOKEN='由服务端配置的管理员令牌'
openappctl status
openappctl --identity admin apps list
openappctl --identity admin apps create story-app "Story App"
openappctl --identity admin apps update story-app archived
openappctl --identity admin build-packages list <app-id> backend
openappctl --identity admin build-packages upload <app-id> backend ./backend.tgz
openappctl --identity admin build-packages upload <app-id> web ./web.tar.gz
openappctl --identity admin apps image update story-app 0 backend=<backend-package-id> web=<web-package-id>
openappctl --identity admin operations wait <operation-id>
openappctl --identity admin apps image bind story-app <candidate-revision-id> 0
openappctl --identity admin cleanup preview
openappctl --identity admin cleanup run
openappctl --identity admin cleanup run 2
openappctl --identity admin build-packages delete <unreferenced-package-id>
openappctl --identity admin image-artifacts delete <unreferenced-artifact-id>
openappctl --identity admin apps versions list story-app
openappctl --identity admin monitor instances
openappctl --identity admin monitor metrics <container-id>
openappctl --identity admin health
openappctl --identity admin audit
openappctl --identity admin operations list
openappctl --identity admin operations get <operation-id>
openappctl --identity admin operations wait <operation-id>
openappctl --identity admin operations cancel <operation-id>
openappctl --identity admin operations retry <operation-id>
openappctl --identity admin config-revisions instance-policy list
openappctl --identity admin config-revisions instance-policy rollback <revision>
openappctl --identity admin users list
openappctl --identity admin containers list
openappctl --identity admin containers start <container-id>
openappctl --identity admin containers stop <container-id>
openappctl --identity admin containers rebuild <container-id>
openappctl --identity admin containers upgrade <container-id>
openappctl --identity admin containers delete <container-id>
openappctl --identity admin images list
openappctl --identity admin images pull <app-runtime-image>:<tag>
openappctl --identity admin images load /srv/images/app-runtime.tar <app-runtime-image>:imported
openappctl --identity admin forwarding get
openappctl --identity admin forwarding test https://portal.example.com
openappctl --identity admin forwarding set https://portal.example.com
openappctl --identity admin forwarding enable
openappctl --identity admin forwarding disable
openappctl --identity admin forwarding allow https://portal.example.com '*.internal.example.com'
openappctl --identity admin policy get
openappctl --identity admin policy auto-create on
openappctl --identity admin policy auto-start on
openappctl --identity admin policy detect-network on
openappctl --identity admin policy detect-compute off
openappctl --identity admin policy idle-stop 30
openappctl --identity admin policy max-instances 100
openappctl --identity admin policy max-running 20
openappctl --identity admin policy default-app <app-id>
openappctl --identity admin policy resources 4g 2 512
openappctl --identity admin policy env ./environment.json
openappctl --identity admin policy config-files ./config-files.json
openappctl --identity admin maintenance sweep
```

CLI 的正常更新入口是 `build-packages upload`、`apps image update` 和
`apps image bind`。update 返回后台 `operationId`；等待成功并检查候选 Revision 后
才能 bind。`apps versions upload/image attach/activate` 只保留旧版本兼容流程，
不要把兼容命令当作新 App 发布入口。

`cleanup preview [keep-previous]` 与 `cleanup run [keep-previous]` 使用相同保留策略，
参数默认为 1，允许 1 到 20。存在历史候选时，执行清理会为每个 App 至少保留最近一个可回滚
Revision，并跳过所有仍被 Container 引用的 Revision。更早的旧 Revision 会归档，
保留包哈希、大小和构建记录等审计摘要；只有没有其他 Revision、ImageBuild 或
Container 引用的 BuildPackage、ImageArtifact、发布文件和 Runtime 镜像会被释放。
预览不是后续删除授权，执行时仍会在数据库中原子复查引用。

镜像 pull/load、App image update、ImageBuild 和兼容 multipart App 版本上传返回后台 `operationId`。
脚本在读取产物或继续发布前，
应执行 `openappctl --identity admin operations wait <operation-id>`，直到任务进入
`succeeded`、`failed` 或 `cancelled`；最长等待 30 分钟。

普通用户可把 Portal 登录 Session token 放在 `OPENAPP_SESSION_TOKEN`，并加 `--identity user`；命令只会看到和操作自己拥有的容器。`--json` 适合脚本调用。

CLI 管理员请求使用专用的 `X-OpenApp-Admin-Token` 请求头；普通用户请求只发送自己的 Portal Session Cookie。服务端必须启用 admin CLI token（`OPENAPP_ADMIN_CLI_TOKEN`）校验，且代理不会把这些控制面凭据转发到用户实例。管理员令牌只应通过环境变量或密钥管理器注入，不能写入命令行历史或仓库。

`images *` 和 `forwarding *` 对应 Portal 管理员 API（镜像 pull/load 同样返回异步任务）：
`GET /api/admin/images`、`POST /api/admin/images/{pull,load}`、
`GET|PATCH /api/admin/forwarding`。用户角色只能从 Web 管理页面变更，不能通过
`openappctl` 晋升。
`images load` 以原始 tar 流上传；Portal 会限制归档大小并通过
Docker-compatible runtime 导入并打上指定引用，不把归档内容解析为命令。

`policy env` 的 JSON 是字符串值对象，例如 `{"FEATURE_FLAG":"enabled"}`。

长操作可通过 `GET /api/admin/operations/:id` 查询；重复请求可发送同一
`Idempotency-Key`，任务按“管理员 + 幂等键”原子创建或复用；同一键用于不同操作、
资源或请求内容时返回 `409 idempotency_key_conflict`。批量实例 ID、镜像归档和成对
发布包都以稳定 SHA-256 请求指纹参与校验，数据库只保存摘要。配置策略与转发策略支持
`GET /api/admin/config-revisions/{instance-policy,forwarding}` 查看历史，使用
`POST .../:revision/rollback` 回滚并生成新版本；保存时应带 `If-Match` 防止覆盖其他管理员的更新。
`policy config-files` 的 JSON 是“相对路径 -> 内容”的字符串对象，例如
`{".claude/settings.json":"{}"}`。Portal 限制配置总大小；Runtime 再拒绝
绝对路径、`..`、空路径段、重复路径和保留环境变量。
配置仅在新实例第一次启动时写入；持久 Volume 中的 marker 会阻止容器重启时
覆盖用户后续修改。
终态任务默认保留 30 天，之后由 Portal 维护周期清理；因此幂等键只在该窗口内保证重放语义。
