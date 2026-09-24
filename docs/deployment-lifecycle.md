# 部署模式与应用版本管理

[文档中心](README.md) · [首次安装](first-install.md) · [组合包部署](plugin-catalog-release.md)

仅启动 Core 并读取已有平台数据库时，设置 `OPENAPP_CONTROL_PLANE_ONLY=true`、`AUTH_PROVIDER=none`，清空 Adapter module/catalog 配置并关闭兼容模式。此模式无需示例插件，支持本地账户与管理数据读取；不启动应用后台任务、业务代理或接受工作负载变更。它使用配置指定的数据库，不会自动创建另一份预览数据库。

完整的通用 bundle、OrbStack/Docker 选择、环境变量和验收命令见 [`backend/deployment/README.md`](../backend/deployment/README.md)。推荐通过 Compose 启动 PostgreSQL、Portal 和受限 Docker Socket Proxy；只有代理挂载宿主机 Socket，Portal 通过内部网络创建隔离的 App Environment。

任意 App 按其 Adapter 的 BuildStrategy 声明上传所需槽位的发布包，得到带来源元数据的 BuildPackage；槽位数量、键名和允许的文件扩展名由策略决定，各包不要求相同 version 或 build ID。日常更新从 App 当前内部 Revision 继承未替换槽位，只构建并烟测一份
新的不可变 ImageArtifact 候选。管理员带 expectedRevision 显式设为当前后，新实例
才会使用它。构建器和 Runtime Dockerfile 由 Adapter 提供并在组合时校验，纯 Core 镜像不内置应用构建材料；管理员不能上传
构建命令。已有实例继续使用自己的 Revision、镜像 ID 和 Volume，只有显式升级才
切换到当前镜像。

历史资源通过 `openappctl cleanup preview` 先预览，再用 `openappctl cleanup run`
执行引用安全清理。保留数范围为 1 到 20，因此存在旧候选时至少留下最近一个可回滚
Revision；任何 Container 正在引用的 Revision 都不会被归档。更早且无实例引用的
Revision 会转为归档审计摘要，只有不再被其他 Revision、ImageBuild 或 Container
引用的 BuildPackage、ImageArtifact、包文件和 Runtime 镜像才会被释放。

模块划分、请求流和运行时隔离不变量见 [`docs/architecture.md`](architecture.md)。
