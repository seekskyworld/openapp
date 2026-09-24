# 应用接入与适用范围

[文档中心](README.md) · [项目首页](../README.md)

## “不更改业务逻辑”的适用条件

应用需要能在独立容器中运行，并提供可配置的端口、启动方式、健康检查和持久化路径。接入时仍需准备 Dockerfile、环境变量和 Adapter；已有登录系统、Cookie 或路径约定通过 Adapter 衔接。业务页面由应用实例提供，不会编译进 OpenApp 的管理前端。

这里的多人使用是**多位用户分别使用自己的应用环境**，不会自动增加同一份业务数据上的实时协作功能。如果应用依赖外部数据库、对象存储或第三方账号，也需要为各实例配置相应的数据与凭据边界；独立容器不会自动隔离共用的外部服务。涉及硬编码部署地址或共享全局状态的应用，仍可能需要调整配置或接入边界。

部署包交付应用运行所需的代码和配置；迁移已有服务时，还需单独备份和恢复数据库、用户数据卷及必要制品。可移植部署不代表数据会随代码包自动迁移。

## 接入与交付流程

**第一次接入请直接按[从现有 Web 应用到双用户独立部署](adapter-tutorial.md)操作。**
教程包含完整可运行的应用和 Adapter、每一步的执行目录与预期结果，以及双用户隔离和重启验收。

1. **准备应用镜像**：保留现有 Web 前后端及业务逻辑，整理启动、端口、健康检查和持久化配置。
2. **开发独立 Adapter**：声明应用身份和运行合同，按需实现登录衔接、登录视图及构建策略。参考 [Adapter 开发指南](adapter-development.md) 和 [Plain Web 示例](../examples/plain-web/README.md)。
3. **组合编译部署包**：选择 Core 与所需 Adapter，由导出器编译并校验版本、资源和来源信息。参见[组合编译](composition-release.md)。
4. **部署并开放使用**：在服务器配置数据库与持久存储，构建控制面镜像，准备业务镜像并初始化管理员。用户登录后，由 OpenApp 管理各自的实例；组合部署继续按[实战教程](adapter-tutorial.md)，仅安装 Core 则看[安装指南](first-install.md)。

## 运行环境支持范围

当前实际运行实现为 Docker-compatible Provider：Linux 使用 Docker Engine，macOS 可使用 OrbStack。
配置选择和连接方式见[Runtime 说明](../backend/runtime/README.md)。

Daytona、Kubernetes 等平台属于 Provider 扩展设计，尚未提供真实生产客户端。
仓库中的 ContractProviderAdapter 是用于合同和故障注入测试的实现，不能当作真实云平台接入。
扩展方向见[执行与访问架构](workspace-execution-gateway-architecture.md)；应用 Adapter 与运行环境 Provider 是不同的接入层。

## 应用与平台的边界

后端插件与 Core 在同一进程运行，应只组合经过审核的 Adapter；插件机制不是不可信代码的安全沙箱。
浏览器扩展支持工作区登录页和控制页的 SSO 区域，不支持任意新增管理菜单或管理页面。
公开能力与源码位置见[Adapter 开发指南](adapter-development.md)和[源码对照](adapter-source-map.md)。
