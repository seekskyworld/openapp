# 开发独立的 OpenApp Adapter

Adapter 是应用与 OpenApp 之间的集成包。Core 提供账户、权限、Tenant/Workspace、调度、存储、代理及发布编排；Adapter 提供应用身份、认证连接、会话交接、品牌界面和构建配方；应用仓库维护业务服务及业务页面。

**初次接入先完成[从零到双用户部署教程](adapter-tutorial.md)。** 本文是完成第一个应用后
查询能力、合同和验收要求的参考。仅使用现成镜像时无需实现 SSO、构建策略或历史兼容。

## 阅读路径

| 要完成的工作                         | 参考                                                                                         |
| ------------------------------------ | -------------------------------------------------------------------------------------------- |
| 从零创建独立仓库                     | 本文第 1–3 节；[可运行 HTTP 应用示例](../examples/plain-web/README.md)                       |
| 确定某块页面或逻辑由谁维护           | [UI、后端与源码对照表](adapter-source-map.md)                                                |
| 定制用户登录页和管理页 SSO           | [浏览器扩展协议](adapter-ui.md)、[可复制验证码 UI 示例](../examples/email-code-ui/README.md) |
| 接入身份服务、Cookie、构建或运行合同 | [后端能力参考](adapter-backend.md)、[公开 contracts](../packages/contracts/README.md)        |
| 多插件组合、发布和服务器更新         | [组合编译](composition-release.md)、[服务器部署](plugin-catalog-release.md)                  |

当前可替换的浏览器视图是普通用户登录页与管理登录页的 SSO 区域。管理页左侧 OpenApp 品牌、本地管理员表单及后台管理页面由 Core 维护。管理表单按 Adapter 声明渲染；当前没有任意菜单或后台页面注入 API。

## 1. 建立独立仓库

建议使用以下结构，不把 Adapter 源码复制进 Core：

```text
sample-adapter/
├── package.json
├── package-lock.json
├── src/index.ts
├── tsconfig.json
├── assets/              # 可选：图标、登录扩展及样式
├── runtime/             # 可选：应用镜像构建材料和 profile.json
├── deployment/build/    # 可选：Adapter 自有构建脚本与校验入口
├── tests/
└── README.md
```

使用 Node.js 24 LTS，在 Adapter 根目录初始化 npm 项目，设置 `type: module`、独立版本及 `build` 脚本；构建入口输出到 `dist/index.js`。先确认 registry 中有目标 `@openapp/contracts` 版本；未公开发布时，使用 [SDK tarball 交付流程](adapter-tutorial.md#2-安装公开-sdk编译-adapter) 安装校验过的版本包。共享构建使用固定 release URL 或已发布 registry 版本，同时声明兼容的 peerDependencies 范围并提交锁文件，不能依赖兄弟源码目录或 workspace 链接。可从 [TypeScript 仓库模板](../examples/adapter-template/README.md) 开始。

最小 package.json 结构如下，合同版本须与所选 Core 匹配：

```json
{
  "name": "@example/sample-adapter",
  "version": "1.0.0",
  "type": "module",
  "exports": { ".": "./dist/index.js" },
  "files": ["dist", "assets", "runtime", "deployment/build", "LICENSE", "README.md"],
  "scripts": { "build": "tsc -p tsconfig.json" },
  "peerDependencies": { "@openapp/contracts": "^0.2.0" },
  "devDependencies": { "@openapp/contracts": "^0.2.0", "typescript": "^5.9.3" }
}
```

TypeScript 使用 NodeNext 模块解析，`rootDir` 为 `src`，`outDir` 为 `dist`。默认导出 `OpenAppAdapterFactory`：接收公开 host，返回 `manifest` 及所需能力。`manifest.id`、`entry.id` 与发布配置中的插件 ID 一致，manifest 的版本与 package.json 一致。

对应的最小 tsconfig.json：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "rootDir": "src",
    "outDir": "dist",
    "strict": true,
    "declaration": true
  },
  "include": ["src/**/*.ts"]
}
```

完成工厂后运行 `npm install` 生成锁文件，再运行 `npm run build`。后续干净检出使用 `npm ci`。如果从 plain-web 示例起步，需统一修改 manifest、entry 和 authHandoff 的 App ID，并根据实际应用补充能力。

可参考 [plain-web 独立工厂](../examples/plain-web/index.mjs) 和 [示例说明](../examples/plain-web/README.md)。示例提供无外部认证的 HTTP 应用、持久计数器、运行 Profile 和目录初始化；在 Docker 中构建对应镜像后可以运行完整的实例生命周期。

## 2. 按需实现能力

| 能力                   | Adapter 提供                                | Core 负责                          |
| ---------------------- | ------------------------------------------- | ---------------------------------- |
| manifest               | App ID、名称、入口、能力、工作负载合同      | 校验身份、版本与注册冲突           |
| authProvider           | 身份服务请求、challenge、身份与公开错误映射 | Portal Session、本地账号及角色授权 |
| authHandoff            | 应用 Cookie、登录/登出和代理凭证策略        | 归属校验、调用与隔离保护           |
| buildProfile / runtime | 应用包槽位、构建配方、健康路径及运行配置    | 构建编排、制品校验与实例生命周期   |
| assets / authUi        | 应用图标、专用登录视图和样式                | 资源命名空间、模块挂载和通用 HTTP  |
| compatibility / legacy | 应用旧路由、纯投影和迁移证据                | 合同校验与通用兼容宿主             |

不需要的能力应省略。专用验证码规则、注册条件及品牌文案在 Adapter 实现，不能修改 Core 登录 Hook 来识别某个应用。Provider 登录成功不授予管理员权限。

没有外部认证的应用声明 `auth.providerId=none`、`entry.challenge=none`，用户入口使用
Core 的普通账号邮箱/密码登录和注册表单，管理入口仍使用独立的管理员登录。
应用默认入口为 `/instances/<id>/ui/`；代理去掉 `/instances/<id>` 后保留 `/ui/`，
应用需通过部署配置或自身路由支持这个路径，并正确处理静态资源与 API base。
完整可运行配置见[教程第 1 节](adapter-tutorial.md#1-创建两个新的独立仓库)。

构建插件需要返回 `buildStrategy`，实现公开 `BuildStrategyAdapter` 的 `execute`，按需实现 `inspectPackage`、`inspectPackages`。实现的 id/revision 必须与 manifest.build 一致；仅返回 buildProfile 不会生成默认构建器。包内文件结构、启动脚本、健康探针与历史格式转换属于 Adapter。Core 保留通用上传、哈希、任务、日志、制品与 Revision 管理。

工厂通过 host.artifacts 使用镜像解析、构建后验证及条件清理能力；host.runCommand 是可选测试注入。脚本路径由受信任的 Adapter 模块选择，不接受数据库或 HTTP 上传的命令。历史上传协议通过 releaseInspector.uploadRequirements 声明字段，通过 inspectUpload 将命名文件转换为通用 packages 快照；旧 host.releaseInspector 字段不提供默认实现。

构建槽位使用公开 validateBuildPackageRequirements 校验：1–32 个唯一槽位，每个槽位声明扩展名、必需性和大小限制。不提供构建功能的 Adapter 应省略 build，不使用空槽位列表。策略归属由公开的 manifest.build.strategyId 确定，跨 App 选择会被后端拒绝。Core 会将其转换成内部 buildStrategies 注册信息；Adapter 不直接声明该内部字段。

AppVersion 使用 packages 数组，不包含固定的双包字段。历史库可由 releaseInspector.legacyPackageColumns 声明“槽位名到旧列名”的映射；宿主仅对声明该映射的 App 幂等回填 packages，保留旧列并在兼容组合写入时同步投影。旧列不得覆盖通用 schema 字段；卸载插件前应先完成该迁移。

仅使用现成镜像的应用无需构建策略。通过 POST /api/admin/apps/:appId/image-imports 提交 imageReference 和 idempotency-key 请求头；返回 202 与 operationId，可通过管理任务接口查询进度、结果及失败原因。同一请求重试应复用幂等键，不同输入复用同一键返回冲突。对应 App 必须有已加载的执行合同。宿主解析不可变镜像、校验合同并执行运行测试，再创建 sourceKind=image 的候选 Revision，导入不自动激活。激活候选继续使用当前 Revision 并发检查。

包更新 replacementPackageIds 的缺省字段表示继承，字符串表示替换为指定包，null 表示移除可选槽位。必需槽位不能移除。全部可选槽位移除后，只有成功构建并绑定制品的 Revision 才可激活；普通空包上传仍拒绝。

contracts 0.2.x 对应 Adapter manifest.apiVersion=v2。旧 v1 插件需要重新适配、编译并组合，不能与当前 Core 混装。旧发布包保留原 SDK 和校验器用于回退。历史上传字段使用 validateUploadRequirements 校验，保留 camelCase；宿主生成落盘文件名，字段不能决定路径。

将构建脚本放入 `deployment/build/` 并列入 npm files。组合导出会携带此目录、dist 和 runtime；独立安装也必须包含这些文件。`@openapp/contracts/runtime-context` 提供共享的 Runtime 发布上下文安全校验，不必依赖 Core 私有脚本。部署须同时采用支持这些能力的 Core、contracts 与 Adapter 版本。

管理接口返回策略的 `executable` 和 `unavailableReason`：历史启用状态与当前可执行性独立；缺少实现、版本不匹配或仅控制面模式时，管理页禁用上传和构建。

浏览器扩展由 package.json 的 `openapp.authUi` 声明 `apiVersion: 1`、`providerId` 和模块文件名。资源放入 `assets/`，组合后以 `/adapter-assets/<id>/` 发布。现代模块导出 `apiVersion = 1` 和 `createAuthUi(host)`，返回 `{ views: { control, workspace } }`，不需要开启 compatibilityMode，在 generic 构建中也会按已注册 Provider 加载。Core 提供 React、request、ApiError 与视图参数，应用图标及交互留在模块内部；管理员登录左侧 OpenApp 品牌仍由 Core 维护。

旧协议专用的 `createAuthCompatibility(host)` 仅在显式 legacy 模式下调用。现代宿主只读取 views，不接收旧数据库投影或旧路由函数。现代登录使用 `/api/auth/external/:provider/login`，额外字段位于 providerData。仅提供旧工厂的模块在 generic 模式下使用默认通用视图；迁移自定义视图时应同时提供新工厂并测试两种模式。

生产代码仅依赖公开合同和自身模块，不导入 Core 私有源码、数据库客户端或测试宿主。导出器要求插件运行依赖自包含：除 Node 内置模块及宿主提供的 contracts 外，第三方运行依赖应打入 dist。不要在 manifest、发布清单或 assets 中写入凭证。

## 3. 验证与组合

环境变量仅按精确键名保护。Core 保留自己的配置传递键；Adapter 应在 `reservedEnvironment` 声明应用不可覆盖的键。`configEnvironmentKey`、恢复环境映射和 Provider 注入键自动纳入保护。Core 不按 `DATA_DIR` 或 `STATE_PATH` 等后缀猜测业务用途。

应用锁恢复是可选能力：`workload.runtime.recoveryCommand` 声明镜像内的可执行文件及参数（例如 `["/usr/local/bin/recover", "--repair"]`），同时声明 `lockRecoveryEnvironment` 的 `containers`、`hosts`、`recoveryId` 环境变量名。不需要恢复的应用同时省略两项。Core 不预设解释器，也不经过 shell；只有已验证归属并停止相关容器后，才会挂载对应 Volume 执行恢复。失败会阻止后续清理或回滚，不能忽略错误继续删除资源。

旧 `recoveryScript` 声明需在 Adapter 中改为显式 `recoveryCommand`，组合校验会拒绝旧声明，避免静默跳过恢复。升级时必须重新组合匹配的 Core 与 Adapter；此合同调整不改写已有数据库或业务 Volume。Runtime 不再导出无人使用的 `@openapp/container-runtime/compat` 包装入口，调用方使用主入口并显式提供 profile 和兼容选项。

先在 Adapter 测试真实工厂、错误分支、登录/登出、凭证隔离、资源路径和 Runtime 合同，再与匹配 Core 组合。多个 Adapter 必须使用不同 App ID，Provider 和其他注册身份不能冲突。

依次阅读 [组合编译](composition-release.md) 和 [服务器部署](plugin-catalog-release.md)。导出会实际编译 Core 与插件、校验注册表并生成文件摘要，不是简单合并源码目录。

Core 或 Adapter 更新后重新生成整个控制面包；Git 提交或替换源码不会自动升级服务器。应用业务镜像更新走独立的 Revision 构建、激活和实例升级流程。数据库及存储验收见 [备份与恢复](operations/backup-restore-runbook.md)。

## 4. 开发验收与排查

1. 独立编译 Adapter，检查 npm 包确实包含 dist、assets、运行和构建材料；运行依赖不能偷偷指向 Core 私有源码。
2. 验证真实工厂的身份/版本、Provider 成功与错误、Cookie 撤销、构建取消和失败清理；仅实现的能力需要对应测试。
3. 用注入的 React 挂载两种登录视图，覆盖发送失败、已有账号、补充字段、重发、修改邮箱和过期响应。参考示例测试，不用固定验证码替代真实身份服务。
4. 在匹配 Core 上组合并运行包内 verify.mjs；核对前后端 Provider ID、静态资源与运行时注册信息一致。若支持历史模式，现代和历史模式分别回归。
5. 在隔离数据库/Volume 副本上验证涉及的迁移与业务生命周期，记录未覆盖项。正式发布使用干净来源、固定版本及来源摘要。

| 现象                                   | 优先检查                                                                              |
| -------------------------------------- | ------------------------------------------------------------------------------------- |
| 自定义登录页没有加载                   | `/auth-adapters.json`、Provider 选择、模块路径/API 版本、现代工厂是否导出；见 UI 参考 |
| 验证码接口返回 auth_provider_not_found | 后端 Provider 是否注册、当前 App 是否允许它；前端图标存在不代表后端可用               |
| 旧账号出现额外注册字段                 | Provider challenge 与 Adapter UI 的字段条件；不能仅按 isNewUser 推断所有注册要求      |
| 管理页有策略但不能构建                 | executable / unavailableReason、已加载策略及 revision、运行 Provider 可用性           |
| 修改插件后页面没变                     | 是否重新组合并部署对应前端镜像，而非只替换后端源码                                    |

## 文档归属

Core 文档维护通用合同、开发步骤及部署机制。Adapter README 维护自己的身份服务、字段规则、品牌视图、Runtime、旧库兼容和具体发布命令。历史产品验收记录也由 Adapter 保存，不能作为 Core 的通用保证。
