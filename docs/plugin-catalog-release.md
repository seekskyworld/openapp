# 插件清单与 OpenApp 部署包

初次从源码组合部署按 Core 仓库的 `docs/adapter-tutorial.md` 执行；已拿到生成包时
按本文配置，不必重新开发或导出 Adapter。纯 Core 安装另见
[首次安装](first-install.md)。本页主要解释交付布局与已有服务的更新边界。

Core 与各 Adapter 独立维护，使用一个构建清单编译并组合交付。
该入口不读取 应用业务包、不构建业务镜像、不操作数据库或实例。

```sh
npm run release:openapp -- /path/to/adapter/config/openapp.release.json /tmp/openapp-release
```

清单格式（source 相对清单文件目录，version 必须精确匹配插件版本）：

```json
{
  "schemaVersion": 1,
  "defaultAppId": "app-a",
  "compatibilityMode": false,
  "plugins": [
    { "id": "app-a", "source": "../../app-a-adapter", "version": "1.0.0", "environment": {} },
    {
      "id": "app-b",
      "source": "../../app-b-adapter",
      "version": "2.0.0",
      "environment": { "APP_LABEL": "App B" }
    }
  ]
}
```

运行前安装 Core、前后端和各插件的构建依赖，插件使用匹配的公开 contracts 包。
插件 dist 必须自包含；除 Node 内置模块和宿主提供的 @openapp/contracts 外，第三方
运行依赖应由插件构建器打入 dist。导出器会拒绝未打包的第三方 dependencies，
避免开发机能加载而服务器缺依赖。
导出器编译前后端与所有插件，验证 manifest、资源和 Runtime，使用真正的平台注册表
验证组合，随后生成独立部署目录。缺包、版本错配、重复身份和注册冲突都中止导出。
`environment` 用于非敏感的插件独立配置，不要把凭证写进发布清单；生产凭证仍由
服务器环境提供。所有插件共享同一个 Node.js 进程，模块边界不是进程级故障隔离。

```text
openapp-release/
├── core/                 # 前后端、Compose、配置模板与运维脚本
│   └── plugins.json      # 运行时插件清单，模块路径由导出器生成
├── openapp-app-a-adapter/
├── openapp-app-b-adapter/
├── build-images.sh
├── verify.mjs
├── source-provenance.json
├── third-party/          # npm 依赖清单及许可文本
└── release-manifest.json
```

服务器通过 `OPENAPP_ADAPTER_CATALOG=/app/backend/plugins.json` 加载清单。
逐项校验模块允许目录、App ID 和版本，再统一检查 Provider/构建策略冲突。
App ID 与插件一一绑定，现有工作区按自身 App ID 获取入口、认证交接和构建能力。
全局 OPENAPP_APP_ID 仅指定默认 App，不再用于校验每个插件的身份。
条目的 environment 使用独立副本传给工厂，不修改进程环境或其他插件的配置。
清单启用后加载失败不会退回内置插件。未设置清单时继续支持旧 OPENAPP_ADAPTER_MODULE。

发布文件清单涵盖所有插件与前端资源；任何文件丢失、修改或额外混入都会校验失败。
各插件资源使用 `/adapter-assets/<id>/` 命名空间。不要在 bundle 中手动替换单个插件，
重新导出匹配的组合即可。身份、角色和租户授权仍由 Core 执行；插件清单不授予用户权限。

带用户 SSO 界面的插件通过 package.json 的 `openapp.authUi` 声明浏览器模块。
导出器生成 `core/frontend/web/auth-adapters.json`，把模块、样式和图片一起放入
`core/frontend/web/adapter-assets/<id>/`。模块分别提供普通登录页与管理页用户 SSO
视图，Core 只提供挂载、通用 HTTP 和登录成功回调。更新这些界面必须重新部署前端
镜像；仅更新后端 Adapter 不会更新浏览器界面。上传时应保留完整目录和隐藏文件，
但不要上传本机实际使用的 `core/.env`，服务器继续使用其自身配置。

升级时在独立目录运行 `node verify.mjs`、`bash build-images.sh`。将服务器旧配置合并到
core/.env，并显式设置原 COMPOSE_PROJECT_NAME 与绝对 OPENAPP_DATA_ROOT，保持原挂载和
Runtime 镜像配置。完成旧数据库迁移验收后只切换 portal-backend、frontend 两个服务。
该入口不携带全量 deploy.sh；构建镜像不等于切换服务，更不等于升级业务实例。

验证命令：`npm --prefix backend test`、`npm --prefix frontend test`、
`node --test scripts/export-openapp.test.mjs`。导出集成测试会重新构建 dist，应串行执行。

首次管理员脚本位于 `core/bootstrap-admin.sh`；已有超级管理员时拒绝执行。空插件部署使用 `config/core.release.json`，全新安装见 [首次安装指南](first-install.md)。现代登录 UI 使用 createAuthUi，不需要 compatibilityMode；旧工厂仅服务历史协议。

正式导出加 `--official`，要求所有组件已提交且工作树干净。检查 source-provenance.json 的版本和 revision，并保留总指纹。容器名默认以 Compose 项目名为前缀，升级旧部署需显式保留原有容器名称，参见首次安装指南中的映射。
