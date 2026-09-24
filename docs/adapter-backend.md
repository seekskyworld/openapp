# Adapter 后端能力参考

本页描述公开 `@openapp/contracts` 的能力与宿主边界。入口见 [开发指南](adapter-development.md)，实现定位见 [源码对照](adapter-source-map.md)。contracts 0.2.x 对应 manifest.apiVersion=v2；浏览器 authUi API 独立使用数字 1。

## 工厂与依赖

默认导出 `OpenAppAdapterFactory`：同步接收 AdapterModuleHost，返回 OpenAppAdapter。网络请求放在能力方法中，不在模块导入或工厂创建时发起。最小可运行参考是 [plain-web/index.mjs](../examples/plain-web/index.mjs)。

| 工厂返回项 | 用途 |
| --- | --- |
| manifest（必需） | 应用 ID/版本、入口、认证声明、工作负载、可选构建及兼容描述 |
| authProvider | 将外部身份协议转换为统一身份及后端凭证 |
| authHandoff | 应用 Cookie、登录/登出交接和代理选项 |
| buildProfile、buildStrategy | 声明构建需求并提供执行方法；只有描述不能构建 |
| releaseInspector | 上传包检查、历史字段到通用槽位的投影 |
| compatibility、legacy | 按需提供历史路由/字段、资源别名和迁移证据；新应用无需默认实现 |

host.environment 是只读配置映射；host.artifacts 提供受控镜像制品操作。runCommand 和 buildScriptPath 是可选注入点，不能假定所有宿主均提供。旧 releaseInspector host 字段不提供默认的应用包解析实现。完整签名以 [index.ts](../packages/contracts/src/index.ts)、[build.ts](../packages/contracts/src/build.ts) 为准。

生产代码只使用公开 contracts、Node 内置模块和插件自身代码。其他运行依赖应打入 dist，满足组合导出器的自包含约束。不导入 Core 数据库、Docker 客户端、私有文件或测试宿主；秘密只从部署环境读取，不写入 manifest、日志和静态文件。

## 外部身份与会话

| Provider 方法/字段 | 输入与输出 | 实现要点 |
| --- | --- | --- |
| id、presentation | Provider ID；可选 label/iconUrl/challenge/fields/capabilities | ID 与 manifest.auth.providerId 一致；展示声明不是权限 |
| sendEmailCode(email) | Promise，返回 `{ providerData?, isNewUser? }` 或 void | 上游挑战要求放在 providerData，公开错误经过映射 |
| login(input) | `{ email, code, providerData? }` → `{ identity, credentialGrant? }` | 验证真实上游身份后返回；grant 仅留后端 |
| mapError(error, operation) | operation 为 email-code 或 login；返回 `{ status, code }` 或 undefined | 只公开稳定、脱敏的错误码，不转发密钥或上游堆栈 |
| validateCredentialGrant / revokeCredentialGrant / revokeSession | 可选生命周期方法 | 按身份系统能力校验、撤销，遵循 contracts 参数类型 |

identity 包含 provider、subject、email，以及可选 displayName/isNewUser。subject 必须来自验证后的服务端身份，不能直接信任表单。Core 负责账户关联、角色授权、Portal Session 和通用持久化；Provider 不返回管理员角色来提升权限。

UI 请求流见 [浏览器参考](adapter-ui.md)。Core 暴露通用 external 路由，再调用当前 App 允许的 Provider。新的专用身份协议应通过公开能力设计接入，不能把任意服务端路由塞入 manifest 绕过授权。

authHandoff 提供 appId、managedCookieNames、onLogin、onLogout、proxyOptions，可选 acceptsCredentialGrant 和 hasSession。登录/登出方法返回 Set-Cookie 字符串；Cookie 名称、域、路径、有效期和撤销规则由 Adapter 明确实现。Core 校验实例归属并调度交接，不默认将所有 Portal Cookie 或上游令牌转发到业务实例。

## 构建、包槽位与 Revision

公开声明是 `manifest.build`，含 strategyId、revision、runtimeContract、imagePrefix、packageRequirements；不是内部的 buildStrategies 数组。Core 把公开声明转换为注册信息。当前公开工厂提供单个 buildStrategy，实现的 id/revision 必须匹配描述。

包槽位由应用定义，不要求叫 frontend/backend，也不固定为两个。`validateBuildPackageRequirements` 校验 1–32 个唯一槽位、扩展名、必需性及大小限制；不构建的应用省略 build。管理页的上传/替换组件属于 Core，所显示的槽位来自已登记声明及历史快照。

BuildStrategyAdapter 可实现 inspectPackage/inspectPackages，必须实现 execute。execute 接收 build、appVersion、可选 standaloneSource、releaseRoot、signal 和异步 report(progress, stage)；返回 imageReference、imageId 及可选 cleanup。执行必须响应取消、报告阶段，妥善处理制品提交前的清理；失败不得返回伪成功。命令、包内结构和启动配方由受信任的 Adapter 实现，不接受数据库或上传文件决定任意执行命令。

Core 负责上传哈希、任务、Revision、制品验证和激活并发控制。replacementPackageIds 中缺省槽位表示继承、字符串表示替换、null 表示移除可选槽位；必需槽位不能移除。数据库中的策略描述不包含执行器，历史启用不等于当前 executable，需同时查看 unavailableReason。

仅使用现成镜像时可通过 `POST /api/admin/apps/:appId/image-imports` 提交 imageReference 与 idempotency-key，得到 202/operationId。导入验证后产生候选 Revision，不自动激活或升级已有实例。业务镜像发布与控制面插件发布分开验收。

releaseInspector 的 uploadRequirements/inspectUpload 用于特定上传协议，legacyPackageColumns 映射旧槽位列到通用 packages。新应用不应为此新增历史数据库字段。迁移必须幂等，不能把兼容投影当作数据库备份或业务恢复证明。

## 运行合同

manifest.workload 描述环境类型、访问模式与健康路径；workload.runtime 明确容器用户、端口、命令、存储路径、资源标签、配置键及保留环境变量。Core 不按应用名称推测默认值。可运行范例见 [plain-web/runtime](../examples/plain-web/runtime/profile.json)。

runtime/profile.json 和构建上下文必须匹配；contextFiles 显式列出所需材料。使用 `@openapp/contracts/runtime-context` 校验上下文，不依赖 Core 私有脚本。不要包含未列出的文件、符号链接、路径穿越或环境密钥。

可选 recoveryCommand 与 lockRecoveryEnvironment 一起声明，后者映射 containers/hosts/recoveryId 环境变量名。不需要应用锁恢复就同时省略；Core 不预设解释器，也不使用 shell 猜测执行方式。资源归属、停止容器及挂载隔离仍由 Core 处理。

## 验收和版本变化

依次验证独立工厂、包内容、Provider/交接、构建失败与取消、运行合同；再组合匹配 Core，验证 HTTP 权限与两种登录视图。涉及历史迁移时使用旧数据库和 Volume 的隔离副本，记录数据一致性、持久性、恢复及升级任务最终状态。只通过编译或 health 不代表业务迁移通过。

合同不兼容时升级 contracts 与受影响 Adapter，并重新编译组合；不能直接替换旧宿主中的插件文件。多插件组合要求应用及注册身份无冲突，但共享控制面进程，源码隔离不等于进程故障隔离。部署方式见 [组合发布](composition-release.md)。
