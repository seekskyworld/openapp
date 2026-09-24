# 组合代码部署包

第一次操作请先用[完整实战教程](adapter-tutorial.md)跑通一个应用。本文作为多插件、
独立仓库和正式来源校验的参考；导出成功之后仍需准备业务镜像和服务器持久配置。

尚未创建插件时，先按 [独立 Adapter 开发指南](adapter-development.md) 准备。本文负责开发机/CI 的组合编译；服务器操作见 [组合包部署](plugin-catalog-release.md)。

Core 与插件分别维护源码。发布时编译并组合成一个可验证的部署包；服务器按包内 Dockerfile 构建 Linux 镜像。业务应用制品不因控制面发布而自动升级。

在 Core 根目录运行 npm ci，再分别为 backend/runtime、backend、frontend 运行 npm ci。contracts 使用根目录锁定的 TypeScript 编译器。每个插件也先安装自身依赖。Node.js 使用 24 LTS。

创建本机组合配置，路径相对于配置文件：

```json
{
  "schemaVersion": 1,
  "defaultAppId": "sample-app",
  "compatibilityMode": false,
  "plugins": [{ "id": "sample-app", "source": "../sample-adapter", "version": "1.0.0" }]
}
```

插件必须提供构建脚本、合法的公开 manifest 与对应版本；此处是配置示例，不是仓库内置业务。多个插件增加 plugins 条目即可，ID 必须唯一。需要历史入口时由该 Adapter 声明兼容能力并显式启用 compatibilityMode。

```bash
npm run release:openapp -- /absolute/path/plugins.json /absolute/path/new-release
node /absolute/path/new-release/verify.mjs
```

导出器编译 Core 后端、前端和各插件，生成插件目录、运行目录 core、release-manifest.json、版本组合信息与镜像配置。输出必须是新目录，防止旧产物混入。只交付导出目录，不打包整个开发工作区。

修改 Core 或插件后重新导出并校验；仅仓库 commit/pull 不会改变线上服务。部署前检查配置、持久数据挂载及恢复点，按服务器维护流程构建并切换。数据库迁移与 Volume 恢复验收见 [备份与恢复](operations/backup-restore-runbook.md)。

产品专用 bundle 的额外预检、布局和迁移要求由相应 Adapter 的发布工具定义，不能混用不同导出器的目录假设。

纯 Core 使用 `config/core.release.json`（空 plugins、compatibilityMode=false）。导出包不包含 Adapter 或 Docker Socket Proxy，首次安装见 [first-install.md](first-install.md)。

正式发布加 `--official`，Core 与每个 Adapter 必须是独立、干净的 Git 仓库，包括未跟踪文件检查。构建前后比较来源以拒绝并发编辑。开发导出允许未提交修改，但明确标为 development。

`source-provenance.json` 记录 Core、contracts、Adapter 版本，以及各组件 Git SHA、dirty 标记和源码摘要，不记录开发机路径或远端地址。`release-manifest.json` 覆盖编译制品、来源记录、脚本与第三方依赖/许可文件，并校验总指纹。官方发布还需保留 CI 结果和迁移验收记录；文件摘要不等于数字签名。
