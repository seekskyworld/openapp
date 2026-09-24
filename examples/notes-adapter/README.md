# Notes Adapter：可运行的独立仓库起点

按 OpenApp Core 仓库中的 `docs/adapter-tutorial.md` 复制本目录到 Core 外的新 Git
仓库。使用已校验 SDK tarball 安装 `@openapp/contracts`，运行 `npm test` 后组合。
首次安装 SDK 时必须按教程使用 `npm install --save-dev <tarball>`，不能先运行 `npm ci`。

- `src/index.ts`：应用身份、本地登录交接、首次应用目录初始化。
- `src/profile.json`：镜像名、端口、启动命令、健康路径、持久目录。
- `openapp.release.json`：选择该 Adapter 的控制面组合配置，source 相对此文件。
- `tests/manifest.test.mjs`：公开 SDK 与凭证边界测试。

业务前后端属于独立的 Notes 应用仓库。本 Adapter 使用现成镜像，不需要构建策略、
上传槽位、自定义 SSO、legacy 或 `runtime/` 镜像构建材料。`auth.providerId=none`
表示没有外部身份服务，OpenApp 本地账号和工作区权限仍然生效。

`catalogBootstrap` 用于空平台数据库的首次初始化；更新镜像仍应走管理页导入候选、
验证、激活与实例升级流程，不能用修改 bootstrap 字段替代升级操作。
