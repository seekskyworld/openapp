<div align="center">
  <img src="frontend/public/openapp-logo.png" alt="OpenApp Logo" width="112" />
  <h1>OpenApp</h1>
  <p><strong>Your single-user app. An independent workspace for everyone.</strong></p>
  <p>Keep your business logic · Separate user environments · One place to deploy and operate</p>
  <p>
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache--2.0-2563eb" alt="License: Apache-2.0" /></a>
    <a href="docs/first-install.en.md"><img src="https://img.shields.io/badge/Deployment-Self--Hosted-16a34a" alt="Self-hosted deployment" /></a>
    <a href="backend/runtime/README.md"><img src="https://img.shields.io/badge/Runtime-Docker%20%7C%20OrbStack-2496ed" alt="Runtime: Docker and OrbStack" /></a>
    <a href="docs/adapter-development.en.md"><img src="https://img.shields.io/badge/Extensible-Adapters-7c3aed" alt="Extensible with Adapters" /></a>
  </p>
  <p>
    English · <a href="README.zh-CN.md">简体中文</a> ·
    <a href="docs/README.en.md">Docs</a> ·
    <a href="docs/getting-started.en.md">Getting started</a> ·
    <a href="CONTRIBUTING.md">Contributing</a> ·
    <a href="docs/support-matrix.en.md">Support matrix</a>
  </p>
</div>

<p align="center">
  <img src="docs/assets/openapp-publicity-EN.png" alt="OpenApp connects an existing single-user application through an Adapter to provide independent application environments and data for multiple users" width="960" />
</p>

---

## You built the app. You shouldn't have to build an entire platform.

A useful Web tool, AI workspace or self-hosted service may work beautifully for one person. Sharing it with more people often means building accounts, permissions, user environments, persistent storage, deployment tooling and upgrade management.

**OpenApp supplies those shared platform capabilities so you can stay focused on the application.**

Connect an existing app through an independent Adapter and give users their own environments behind one entry point. Reduce the need for a separate platform team or a new project to rewrite the application as a multi-tenant system.

Users share the application image, while their workspaces and persistent data remain separate. Your app handles its business; OpenApp handles access and environment management.

## Why OpenApp

- **Reuse platform capabilities.** Centralize accounts, authorization, instance lifecycle, access proxying, resource limits and monitoring instead of rebuilding an administration system for every project.
- **Give each user their own space.** Provide independent environments and persistent storage, with server-side ownership checks controlling access.
- **Keep your stack and application structure.** An Adapter describes build inputs, startup and integration. Projects do not have to fit a fixed frontend/backend package layout.
- **Bring multiple projects together.** Maintain Core, Adapters and applications independently; compose selected integrations through public contracts.
- **Prepare once, deploy from a directory.** Compile Core and Adapters into a bundle with Dockerfiles, configuration and integrity checks. Servers do not need to assemble source repositories.
- **Control upgrades and operating costs.** Update the platform separately from application images, check candidates before activation, and manage instances through the UI and CLI with resource limits and idle stopping.
- **Own your deployment.** Self-host and extend under Apache-2.0. Docker and OrbStack are implemented today; common Provider interfaces provide a foundation for other execution platforms.

## Built for existing projects

Personal Web tools, AI workspaces, internal applications and open-source self-hosted services can offer independent environments to more users while reusing their existing business logic.

Applications must be suitable for containerized execution. Integration still needs application-specific configuration, authentication handoff where applicable, and appropriate boundaries for external data services. See [integration requirements](docs/getting-started.en.md#integration-requirements).

## What's next

We plan to extend the execution layer with Kubernetes (K8s) support and more runtimes and infrastructure Providers, so the same application integration can reach more deployment environments. Docker and OrbStack are supported today; these additional backends are planned, not currently available. Contributions to public contracts, Provider implementations and real deployment tests are welcome.

## Bring your application

[**Follow the tutorial: from a single-user app to two independent user workspaces →**](docs/adapter-tutorial.en.md)

[Getting started](docs/getting-started.en.md) · [Documentation](docs/README.en.md) · [Adapter development](docs/adapter-development.en.md) · [Composition](docs/composition-release.en.md)

Contributions are welcome: see [contributing](CONTRIBUTING.md), [support](SUPPORT.md) and the [security policy](SECURITY.md).

## License

OpenApp Core, repository packages and the OpenApp Logo are licensed under [Apache License 2.0](LICENSE). Third-party dependencies and independent plugins retain their own licenses; see [third-party notices](THIRD_PARTY_NOTICES.md).

Copyright © 2026 OpenApp Contributors.
