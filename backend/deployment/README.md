# OpenApp 部署

Core 提供通用控制面、Runtime 和部署模板。应用认证、品牌、下游会话、构建策略与历史兼容行为由独立 Adapter 提供，业务源码和用户数据不进入 Core 仓库。

## 发布形态

1. 源码构建：从完整 Core 检出构建通用 Portal 镜像，外部 Adapter 由配置加载。
2. 预编译组合包：在开发/CI 中编译 Core 和指定插件，导出 JavaScript 后端、静态前端、插件及 Docker/Compose 配置；服务器只执行 Linux 镜像构建和部署。
3. 历史兼容包：由对应 Adapter 显式提供 legacy manifest、迁移描述和恢复材料。通用模板不会自动猜测旧布局或插件。

## 源码构建

要求 Docker Engine 与 Compose、Node.js 24 LTS（本机编译时）。仓库根目录执行：

~~~bash
docker build -f backend/deployment/portal/Dockerfile -t openapp-portal:local .
cp backend/deployment/.env.production.example backend/deployment/.env
# 填写数据库密码、域名、管理员令牌、Adapter 路径与 Docker GID。
docker compose --env-file backend/deployment/.env -f backend/deployment/docker-compose.yml config --quiet
docker compose --env-file backend/deployment/.env -f backend/deployment/docker-compose.yml up -d
~~~

Dockerfile 在干净上下文内构建 contracts、Runtime、后端和前端，最终层只复制运行依赖与生产产物。Node/Docker/npm 默认使用官方来源；受限网络可显式覆盖 NODE_BASE_IMAGE、DOCKER_CLI_IMAGE、NPM_REGISTRY、DEBIAN_MIRROR。

## Adapter 装配

- OPENAPP_ADAPTER_MODULE：已构建插件入口。宿主机开发使用真实绝对路径；容器部署使用映射后的容器路径。
- OPENAPP_ADAPTER_ALLOWED_ROOTS / OPENAPP_ADAPTER_ALLOWED_PACKAGES：允许加载的目录或包。只配置经过审查的插件。
- OPENAPP_ADAPTER_REQUIRED=true：缺少插件或合同不匹配时停止启动，不能静默回退。
- AUTH_PROVIDER=none：不提供外部认证；本地账号仍由 Core 管理。其他 Provider 必须通过插件注册。测试认证不属于生产默认实现。
- OPENAPP_AUTH_PROVIDER_BASE_URL：可选的外部身份服务地址，由 Adapter 解释；为空时采用 Adapter 明确声明的默认值。

前端通过 manifest 获取入口和认证方式。默认表单渲染字段描述并传递 providerData；验证码格式、注册条件和专用界面由 Provider/Adapter 拥有。

## 预编译组合发布

使用根目录 scripts/export-openapp.mjs 与组合配置导出多个已固定版本的插件；配置格式和命令见 [组合发布](../../docs/composition-release.md)。scripts/export-deployment-bundle.sh 仅转交给显式选择的 Adapter 的 scripts/export-legacy-bundle.sh，不在 Core 内解释旧业务包布局。

旧布局组合锁的新 schemaVersion 为 3，app.files 记录交付目录中文件的相对路径、大小和 SHA256，不假设包数量、扩展名或业务目录名称。原发布包自带的历史锁与验证器用于历史包回滚，不应把新验证器单独覆盖进旧包。

两种导出包的命令不同，不能混用：

- 多插件组合包：包含 `release-manifest.json`、`verify.mjs`、`build-images.sh` 和 `core/plugins.json`。先运行 `node verify.mjs`，再运行 `bash build-images.sh`。它不提供 `preflight.sh` 或 `deploy.sh`；构建后按 [组合包操作说明](../../docs/plugin-catalog-release.md) 保留原项目名、数据挂载和配置，仅切换控制面服务。
- 旧单 Adapter 完整 bundle：包含 `.openapp-composition-lock.json`、源码指纹、`preflight.sh`、`deploy.sh`。按 [完整 bundle 说明](bundle/README.md) 预检和部署；历史兼容布局还需遵循 Adapter 提供的说明。

缺文件、未知布局或校验不一致时停止，不要手工改锁或清单绕过校验。

业务镜像发布与控制面发布是独立操作：按 BuildStrategy 的任意槽位上传包，创建候选 Revision，构建并健康验证不可变 ImageArtifact，带 expectedRevision 显式激活。现有实例只有在显式升级后才换镜像，始终保留对应 StorageBinding。

## 网络与持久化

PostgreSQL 仅在内部 control 网络可达。只有 docker-socket-proxy 挂载 Docker Socket，Portal 经内部 docker-control 网络调用它；禁止对外发布 2375。用户实例不挂载管理 Socket、不共享其他用户网络。

OPENAPP_PORTAL_CONTAINER 必须与 Compose 容器名一致。实例 Network/Volume 使用受管标签验证归属，不能采用或删除身份不匹配的资源。专用地址池 OPENAPP_NETWORK_POOL_CIDR 默认 10.240.0.0/12，子网前缀默认 28，部署前检查与宿主机/VPC/VPN 是否冲突。

生产必须配置 PostgreSQL。发布目录必须可写，保存 BuildPackage、Revision、构建输入及审计数据。不要用代码同步覆盖 .env、数据库、发布目录或用户 Volume。

## 初始化与升级验收

导出包的 bootstrap-admin.sh 显式引导首个超级管理员，不包含默认账号或密码。已有数据库升级时保留账户与角色，不再次初始化账号。

发布前保存旧镜像、组合锁、数据库与 Volume 备份，并在隔离环境恢复验证：连续迁移两次，核对行内容摘要和归属，测试登录/权限、业务访问、启停、升级、持久化与回滚。只通过 health 或静态页面不代表完整业务验收。

详细标准见 [备份与恢复](../../docs/operations/backup-restore-runbook.md) 与 [部署包说明](bundle/README.md)。本地合同/导出回归命令：

~~~bash
npm run test:deployment
npm run test:release
npm run test:profiles
npm run test:acceptance
~~~

真实数据库/Volume 测试只使用显式指定的可丢弃环境。未执行项记录为未验证，不能视为通过。
