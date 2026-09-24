<div align="center">
  <img src="frontend/public/openapp-logo.png" alt="OpenApp Logo" width="112" />
  <h1>OpenApp</h1>
  <p><strong>让单用户应用，成为每个人都能独立使用的服务。</strong></p>
  <p>保留业务逻辑 · 独立用户环境 · 统一部署与运维</p>
  <p>
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache--2.0-2563eb" alt="License: Apache-2.0" /></a>
    <a href="docs/first-install.md"><img src="https://img.shields.io/badge/Deployment-Self--Hosted-16a34a" alt="Self-hosted deployment" /></a>
    <a href="backend/runtime/README.md"><img src="https://img.shields.io/badge/Runtime-Docker%20%7C%20OrbStack-2496ed" alt="Runtime: Docker and OrbStack" /></a>
    <a href="docs/adapter-development.md"><img src="https://img.shields.io/badge/Extensible-Adapters-7c3aed" alt="Extensible with Adapters" /></a>
  </p>
  <p>
    简体中文 · <a href="README.md">English</a> ·
    <a href="docs/README.md">文档</a> ·
    <a href="docs/adapter-tutorial.md">接入你的应用</a> ·
    <a href="CONTRIBUTING.md">参与贡献</a>
  </p>
</div>

<p align="center">
  <img src="docs/assets/openapp-publicity-CN.png" alt="OpenApp：通过 Adapter 将现有单用户应用接入统一平台，为多位用户提供独立的应用环境与数据" width="960" />
</p>

---

## 已经有好用的应用，不必再从头造一个平台

你已经做出了一个好用的 Web 工具、AI 工作台或自托管服务。它能服务一个人，但让更多人使用，往往还要补上账号、权限、用户环境、持久存储、部署后台和升级管理。

**OpenApp 把这些共用的平台能力准备好，让你把精力留给业务本身。**

通过独立 Adapter 接入，原本面向单用户的应用也能从统一入口为多位用户提供各自的运行环境。无需为了这一目标重新组建一支平台团队，也不必另起项目，把整套业务重构成多租户系统。

同一份应用镜像，用户 A 有自己的工作区与数据，用户 B 也有自己的工作区与数据。业务应用继续处理它擅长的事情，OpenApp 负责环境分配、访问控制和运行管理。

## 为什么选择 OpenApp

### 业务继续迭代，平台能力直接复用

账号、权限、实例启停、访问代理、资源限制和运行监测由统一控制面承接。接入工作集中在 Adapter，减少每个项目重复开发一套管理后台的成本。

### 从一个人使用，到多人各用各的

为用户工作区提供独立运行环境与持久存储，通过服务端归属检查控制访问。适合把个人工具、内部应用和单用户服务开放给更多人，而不把所有人的业务状态混在一起。

### 不绑定某一种业务，也不规定你的技术栈

应用可以有自己的前端、后端和启动方式。Adapter 描述它如何构建、启动和接入，Core 提供通用能力；发布包的数量和类型由应用决定，不要求每个项目都是固定的“前端 + 后端”结构。

### 一套平台，接入多个项目

Core、Adapter 和业务应用各自维护。通过公开接口开发独立 Adapter，按需组合多个应用，复用同一套用户管理、部署工具和运维入口。

### 开发机组合好，服务器按包部署

把 Core 与选定 Adapter 编译成一个带配置、Dockerfile 和完整性校验的部署目录。服务器不需要重新拼接源码仓库，让交付、复现和自托管更简单。

### 更新有节奏，运行有掌控

平台与业务镜像分别更新，候选镜像经过检查再激活，已有实例按计划升级。配合管理页面、CLI、任务记录、闲置停止与资源限制，兼顾日常运维和运行成本。

### 代码与部署都由你掌握

Apache-2.0 开源许可，支持自托管和二次开发。当前运行实现支持 Docker 与 OrbStack，并通过通用 Provider 接口为其他执行平台提供扩展基础。

## 后续规划

我们计划继续扩展底层执行能力，增加 Kubernetes（K8s）、更多运行时与基础设施 Provider，让同一套应用接入方式覆盖更多部署环境。当前已实现 Docker 与 OrbStack；这些新增底层支持属于后续规划，尚未提供。欢迎参与公开接口、Provider 实现及真实部署测试。

## 适合什么项目

- **个人 Web 工具**：让更多人拥有自己的笔记、文件处理或自动化工作区。
- **AI 应用与工作台**：为不同用户分配独立的应用环境和持久数据。
- **团队内部系统**：复用现有工具，统一入口、权限和运行管理。
- **开源自托管项目**：在既有单用户部署方式之外，提供多人独立使用的交付方案。

OpenApp 采用“独立环境承载多用户”的方式。应用需要具备可容器化运行的条件；外部数据服务、认证和配置仍需按应用完成接入。具体见[适用范围与接入边界](docs/application-integration.md)。

## 从你的应用开始

[**跟着教程，接入一个应用并验证双用户独立使用 →**](docs/adapter-tutorial.md)

[文档中心](docs/README.md) · [Adapter 开发](docs/adapter-development.md) · [组合编译](docs/composition-release.md) · [首次安装](docs/first-install.md)

欢迎通过[贡献指南](CONTRIBUTING.md)参与开发，或通过[支持渠道](SUPPORT.md)反馈使用体验。安全问题请遵循[安全政策](SECURITY.md)。

## 许可证

OpenApp Core、本仓库子包及 OpenApp Logo 采用 [Apache License 2.0](LICENSE)。第三方依赖与独立插件保留各自许可证，详见[素材与第三方说明](THIRD_PARTY_NOTICES.md)。

Copyright © 2026 OpenApp Contributors.
