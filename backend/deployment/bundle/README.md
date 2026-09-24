# OpenApp 独立部署包

本目录只提供通用容器、网络及运维模板，不能复制后直接上线。单 Adapter 历史包的 deploy.sh、preflight.sh 及业务包环境配置由 Adapter 自己提供，Core 不定义业务包数量、名称或布局。完整历史包由显式选择的 Adapter 导出器组装。

`scripts/export-openapp.mjs` 生成的多插件组合包使用 `verify.mjs` 和 `build-images.sh`，不提供上述 deploy/preflight 脚本；请按 [组合包说明](../../../docs/plugin-catalog-release.md) 操作，本页步骤不适用于该包。

## 首次部署

1. 校验传输归档 SHA-256，解压到新的发布目录，不覆盖活动数据目录。
2. 复制 .env.production.example 为 .env，填写 PostgreSQL 密码、管理员令牌、真实域名、Docker GID、发布目录和显式 Adapter 配置。
3. 配置 PUBLIC_HOSTNAME/PUBLIC_ORIGIN 与独立的 MCP_APP_SANDBOX_HOSTNAME/MCP_APP_SANDBOX_ORIGIN，例如 openapp.example.com 与 mcp.example.com；沙箱源不得提供管理 API 或登录接口。
4. 运行 ./preflight.sh。组合锁、指纹、插件和文件校验必须全部通过。
5. 运行 ./deploy.sh；首次空库健康后运行 ./bootstrap-admin.sh，交互创建初始超级管理员。

生产默认通过配置的 Dockerfile 构建 Linux 镜像；预编译代码包不等于镜像归档。需要 App Runtime 的组合应显式提供对应构建材料，不能把升级控制面理解为自动升级所有业务实例。

## 日常升级

保存现有镜像、配置、组合锁、数据库和用户 Volume 备份。在独立环境恢复副本、运行迁移两次并验收功能。通过后在新发布目录配置原有持久化位置并执行预检，再按维护窗口切换。

不要执行清空 Volume 的 Compose 命令，不要用文件同步删除运行目录内容。原用户、角色、实例归属、Revision/ImageArtifact 与 StorageBinding 必须保持。旧任务必须闭环或明确记录阻塞；新版本运行后产生的写入不能因恢复旧备份而直接丢弃。

Core 与 Adapter 更新需要重新生成组合包并固定版本；业务包更新按已注册策略上传、构建和激活，现有实例需显式升级。某个仓库提交更新不会自动改变线上部署。

## 验收

控制面：健康、页面、账户、本地/外部登录、角色权限、跨用户拒绝、写入重启持久性。

业务：Volume 恢复、旧数据读取、进入/刷新/长连接、启停、镜像升级、失败恢复、跨用户隔离。

恢复：旧完整发布能读取匹配的数据副本；保存迁移日志、摘要、镜像 ID、版本锁和回滚方案。未验证项必须单独列出。

应用专有旧布局、Cookie 和锁恢复由相应 Adapter 的发布说明定义，通用包不会提供隐式替代实现。
