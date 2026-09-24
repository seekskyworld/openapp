# Adapter 的 UI、逻辑与源码位置

本文是当前实现的定位表。Core 路径供理解宿主和排查问题，**不是 Adapter 可导入的接口**。独立 Adapter 的生产代码只依赖公开 contracts 与自身模块。下表的 Adapter 文件名是推荐组织方式；真正入口由导出工厂、manifest 和 package.json 决定。

## 页面归属

| 页面或区域                                                      | Core 的 UI / 挂载位置                                                                                                                                                                                             | Adapter 的职责与建议位置                                                                                       |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 无 Adapter 时的首页提示和控制台按钮                             | [UnavailableEntryPage.tsx](../frontend/src/features/entry/UnavailableEntryPage.tsx)                                                                                                                               | 无；不得用应用品牌覆盖平台不可用提示                                                                           |
| 已接入应用的用户入口、恢复会话、进入工作区                      | [App.tsx](../frontend/src/App.tsx)、[WorkspaceEntryPage.tsx](../frontend/src/features/entry/WorkspaceEntryPage.tsx)、[user-entry-flow.ts](../frontend/src/features/entry/user-entry-flow.ts)                      | `src/manifest.ts` 声明应用入口、认证 Provider、challenge；不接管 Core 的归属检查和实例创建                     |
| 普通用户登录页                                                  | [WorkspaceLoginPage.tsx](../frontend/src/features/auth/WorkspaceLoginPage.tsx) 挂载扩展或通用表单                                                                                                                 | `assets/auth-ui.mjs` 返回 `views.workspace`；应用布局、图标、表单、挑战规则、错误文案归 Adapter                |
| 管理登录页左侧 OpenApp 图标、标题、介绍                         | [LoginPage.tsx](../frontend/src/features/auth/LoginPage.tsx)、[auth-i18n.ts](../frontend/src/auth-i18n.ts)                                                                                                        | 不覆盖；此区域属于平台                                                                                         |
| 管理登录页右侧应用 SSO 按钮及登录步骤                           | [LoginPage.tsx](../frontend/src/features/auth/LoginPage.tsx) 的 `views.control` 挂载点                                                                                                                            | `assets/login-views.mjs` 等实现图标、点击后面板、邮箱→验证码和补充字段                                         |
| 本地管理员邮箱/密码表单与语言切换控件                           | [LoginPage.tsx](../frontend/src/features/auth/LoginPage.tsx)、[AuthLanguageSelect.tsx](../frontend/src/features/auth/AuthLanguageSelect.tsx)                                                                      | 不替换本地认证；插件视图接收 locale，可维护自身文案                                                            |
| App 名称、描述、当前 Revision、包槽位、上传/替换/继承、候选镜像 | [AppsPanel.tsx](../frontend/src/features/admin/AppsPanel.tsx)、[app-build-state.ts](../frontend/src/features/admin/app-build-state.ts)                                                                            | manifest 提供身份；`manifest.build` 声明任意命名槽位及限制；`src/build/` 解释制品并构建。表单组件本身属于 Core |
| 实例列表、启动/停止及状态                                       | [UserDashboard.tsx](../frontend/src/features/instances/UserDashboard.tsx)、[ResourcesPanel.tsx](../frontend/src/features/admin/ResourcesPanel.tsx)                                                                | 声明 runtime、健康路径、存储约定；不注入实例管理页面                                                           |
| 升级批次、任务进度及日志                                        | [UpgradeRolloutsSection.tsx](../frontend/src/features/admin/UpgradeRolloutsSection.tsx)、[OperationsPanel.tsx](../frontend/src/features/admin/OperationsPanel.tsx)                                                | 构建器按合同报告进度、响应取消、返回结果；通用状态机和操作按钮属于 Core                                        |
| Runtime 诊断、策略、转发规则                                    | [RuntimePanel.tsx](../frontend/src/features/admin/RuntimePanel.tsx)、[PolicyPanel.tsx](../frontend/src/features/admin/PolicyPanel.tsx)、[ForwardingPanel.tsx](../frontend/src/features/admin/ForwardingPanel.tsx) | 提供已有公开运行合同和会话策略；没有任意后台菜单/面板注册接口                                                  |
| 应用内部业务界面                                                | 由 [proxy.ts](../backend/src/proxy.ts) 等代理进入实例                                                                                                                                                             | 业务应用仓库维护；不把整个业务前端编译成控制面登录插件                                                         |

**当前可执行浏览器扩展只有两种登录视图。** `views.control` 是管理登录页中的 SSO 区域，不是整个 `/control` 后台。名称、描述、错误目录和构建槽位属于声明式扩展，不等于任意 HTML/脚本插槽。新后台扩展点需要单独设计公开合同，不能把组件塞进 manifest 或数据库绕过宿主。

应用明确声明 `entry.challenge=none` 且没有外部 Provider 时，普通用户使用 Core 的
[LocalWorkspaceLoginPage.tsx](../frontend/src/features/auth/LocalWorkspaceLoginPage.tsx)
登录或注册本地账号。这是通用平台认证，不要求 Adapter 为本地密码另写登录页面。
前端 `/api/entry/manifest` 响应中的 `authProviderId` 在无外部 Provider 时可能省略，
不能仅凭字段缺失就判断 Adapter 不可用。

## 逻辑归属

| 逻辑                                        | Adapter 入口                                                                | Core 宿主实现                                                                                                                                                                                                       |
| ------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 加载与身份/版本校验                         | `src/index.ts` 默认导出工厂，返回 manifest 与能力                           | [adapter-catalog.ts](../backend/src/adapter-catalog.ts)、[external-adapter.ts](../backend/src/external-adapter.ts)、[platform-plugins.ts](../backend/src/platform-plugins.ts)                                       |
| 发送验证码、验证身份、映射公开错误          | `authProvider`，建议 `src/auth-provider.ts`                                 | [portal-app.ts](../backend/src/portal-app.ts) 的通用 HTTP 路由、[provider-registry.ts](../backend/src/auth/provider-registry.ts)                                                                                    |
| 账户关联、角色、Portal Session、本地密码    | 不实现/不授予管理员角色                                                     | [portal-auth.ts](../backend/src/auth/portal-auth.ts)、[core.ts](../backend/src/auth/core.ts)、[local-password.ts](../backend/src/auth/local-password.ts)、[user-role-policy.ts](../backend/src/user-role-policy.ts) |
| 下游凭证、Cookie 交接与登出撤销             | `authHandoff`，建议 `src/handoff.ts`                                        | [app-auth-handoff.ts](../backend/src/auth/app-auth-handoff.ts)、[proxy.ts](../backend/src/proxy.ts)                                                                                                                 |
| UI 清单选择与同源模块加载                   | package.json `openapp.authUi`、`assets/auth-ui.mjs`                         | [auth-ui.ts](../frontend/src/features/auth/auth-ui.ts)；旧工厂仅通过 [compat/load.ts](../frontend/src/features/auth/compat/load.ts)                                                                                 |
| 包格式、包内版本解析和具体构建命令          | `buildStrategy`、`releaseInspector`，建议 `src/build/`、`deployment/build/` | [build-package-upload.ts](../backend/src/build-package-upload.ts)、[image-builds.ts](../backend/src/image-builds.ts)、[app-image-updates.ts](../backend/src/app-image-updates.ts)                                   |
| 健康、用户、端口、Volume 挂载和可选恢复命令 | `manifest.workload.runtime`、`runtime/profile.json`、`runtime/`             | [runtime-contracts.ts](../backend/src/runtime-contracts.ts)、[docker-cli-runtime.ts](../backend/runtime/src/docker-cli-runtime.ts)                                                                                  |
| 工作区权限、租户归属、调度及重建            | 不接触 Core 数据库或 Docker 客户端                                          | [workspace-authorization.ts](../backend/src/workspace-authorization.ts)、[workspace-execution-manager.ts](../backend/src/workspace-execution-manager.ts)                                                            |
| 历史字段/路由投影与迁移证据                 | 可选 `legacy` / `compatibility`，建议 `src/legacy/`                         | [legacy-host.ts](../backend/src/legacy-host.ts)、[persistence/postgres.ts](../backend/src/persistence/postgres.ts) 执行受控宿主逻辑                                                                                 |
| 编译、资源复制、来源指纹与交付              | Adapter 的 build 脚本、发布配置及自有材料                                   | [export-openapp.mjs](../scripts/export-openapp.mjs)；服务器按包内 Dockerfile 构建镜像                                                                                                                               |

## Core 维护模块

这些模块均是通用宿主实现，不是插件接口：

- [http-security.ts](../backend/src/http-security.ts)：写请求来源校验和请求日志路径脱敏。
- [portal-static.ts](../backend/src/portal-static.ts)：直接托管前端模块、MIME、缓存和静态路径边界。
- [portal-readiness.ts](../backend/src/portal-readiness.ts)、[server-lifecycle.ts](../backend/src/server-lifecycle.ts)：数据库就绪探测、HTTP 排空和连接池关闭。
- [postgres-schema.ts](../backend/src/persistence/postgres-schema.ts)、[postgres-records.ts](../backend/src/persistence/postgres-records.ts)：数据库结构和记录映射；连接与仓储操作仍在 `postgres.ts`。
- [docker-runtime-support.ts](../backend/runtime/src/docker-runtime-support.ts)：运行时配置与标签解析；生命周期编排仍在 `docker-cli-runtime.ts`。

## 数据库中的内容为什么还能显示

数据库保留应用目录、策略描述/槽位快照、版本、制品、用户和实例状态。管理页通过 API 渲染这些数据。数据库不保存可加载的 Adapter JavaScript，也不能使缺失的 Provider/构建器恢复执行。

因此卸载 Adapter 后，历史名称和版本可能仍可查看；当前可执行性必须以 `executable`、`unavailableReason` 和宿主已加载能力为准。不得因为存在历史策略行就启用上传/构建；也不应为了隐藏历史名称删除用户数据。

## 修改什么，需要重发什么

| 修改                                     | 交付动作                                                                |
| ---------------------------------------- | ----------------------------------------------------------------------- |
| 登录 UI、CSS、图标、浏览器文案           | 重新组合控制面包并部署前端镜像；只更换后端插件不会更新浏览器资源        |
| Provider、handoff、构建器或后端 manifest | 重新组合并部署匹配的后端；涉及入口/资源变化同时更新前端                 |
| 运行 Profile、启动脚本、业务服务合同     | 构建匹配业务镜像，按 Revision 验收/激活；同步发布需要的新 Adapter 合同  |
| Core/contracts 公共接口                  | 升级并测试所有受影响 Adapter，重新组合，不直接把新插件放入不兼容旧 Core |
| 业务 UI 的普通功能                       | 在应用仓库发布业务镜像；不因其改动自动重建控制面                        |

部署目录可同时包含 Core 与多个 Adapter 的编译产物，这不会改变源码所有权。继续阅读 [UI 合同](adapter-ui.md)、[后端合同](adapter-backend.md) 和 [组合发布](composition-release.md)。
