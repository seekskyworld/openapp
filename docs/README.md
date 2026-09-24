# OpenApp 文档中心

[项目首页](../README.zh-CN.md) · [English documentation](README.en.md)

OpenApp 为已有应用提供统一控制面，通过独立 Adapter 接入应用，为用户管理各自的运行环境。
这里集中说明接入、开发、组合部署与运维；具体应用的认证规则、品牌、业务制品和历史兼容操作由各自 Adapter 仓库维护。

## 第一次使用

- **想让现有单用户应用供多人独立使用**：先读[适用范围与接入边界](application-integration.md)，再按[双用户实战教程](adapter-tutorial.md)完成接入、组合、启动与验收。
- **只想体验管理控制面**：按[首次安装](first-install.md)部署纯 Core。没有 Adapter 时不提供业务应用的运行能力。
- **准备修改 OpenApp 源码**：按[本地开发与测试](local-development.md)安装依赖、选择运行方式并执行检查。
- **已有部署需要升级**：先看[组合包部署](plugin-catalog-release.md)和[备份恢复手册](operations/backup-restore-runbook.md)，保留原数据库、数据目录和服务身份。

## 开发 Adapter

| 需求                         | 文档                                                                                               |
| ---------------------------- | -------------------------------------------------------------------------------------------------- |
| 从零完成一个可运行的接入     | [实战教程](adapter-tutorial.md)                                                                    |
| 在独立仓库开发 Adapter       | [开发指南](adapter-development.md)、[公开合同与 SDK](../packages/contracts/README.md)              |
| 找到 UI 与后端逻辑的扩展位置 | [源码对照](adapter-source-map.md)、[UI 协议](adapter-ui.md)、[后端能力](adapter-backend.md)        |
| 参考可运行的应用与登录扩展   | [Plain Web](../examples/plain-web/README.md)、[邮箱验证码 UI](../examples/email-code-ui/README.md) |
| 理解支持范围和接入条件       | [应用接入边界与运行环境](application-integration.md)                                               |

## 组合、部署与运维

| 需求                                      | 文档                                                                                                     |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 把 Core 与一个或多个 Adapter 编译为部署包 | [组合编译](composition-release.md)                                                                       |
| 构建镜像、首次启动、初始化管理员          | [首次安装](first-install.md)、[部署配置](../backend/deployment/README.md)                                |
| 更新服务器上的控制面                      | [组合包部署](plugin-catalog-release.md)                                                                  |
| 理解纯 Core 模式、业务镜像更新和资源保留  | [部署与版本管理](deployment-lifecycle.md)                                                                |
| 管理用户、实例、任务和构建制品            | [管理台运维](admin-operations.md)、[后端与 CLI](../backend/README.md)                                    |
| 选择 Docker 或 OrbStack                   | [Runtime 说明](../backend/runtime/README.md)                                                             |
| 验证迁移、数据恢复及外部服务边界          | [备份恢复](operations/backup-restore-runbook.md)、[外部边界策略](operations/external-boundary-policy.md) |

## 理解架构与参与贡献

- [系统架构](architecture.md)与[领域术语](../CONTEXT.md)：模块职责、请求流和数据边界。
- [执行与访问架构](workspace-execution-gateway-architecture.md)：Provider 扩展设计；各运行环境的实际支持范围见[接入说明](application-integration.md)。
- [本地开发](local-development.md)与[贡献指南](../CONTRIBUTING.md)：依赖、运行配置、测试与代码规范。
- [组合编译](composition-release.md)与[项目治理](../GOVERNANCE.md)：SDK、发布来源与质量检查。
- [变更记录](../CHANGELOG.md)、[安全政策](../SECURITY.md)、[支持渠道](../SUPPORT.md)和[第三方说明](../THIRD_PARTY_NOTICES.md)。
