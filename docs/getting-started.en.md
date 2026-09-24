# Getting started with OpenApp

[Project overview](../README.md) · [Documentation index](README.en.md)

## Integration requirements

An application must run in an independent container with configurable startup, ports, health checks and persistent paths. Integration still requires container packaging, environment configuration and an Adapter. Existing authentication, cookies and routing may need adaptation; hardcoded deployment assumptions or shared global state may need adjustment. Business pages remain served by the application instance rather than being compiled into the Portal frontend.

Multiple users receive independent environments; OpenApp does not automatically add real-time collaboration over shared business data. External databases, object stores and third-party credentials also need appropriate per-instance boundaries. Moving a deployment requires separate backup and restoration of databases, user volumes and artifacts; the code bundle does not contain those live data.

The workflow is: prepare the application image, implement an Adapter, compile a composition, then deploy and initialize the administrator. Follow the guides below for each step.

Use Node.js 24 LTS and npm. Docker Engine or OrbStack is required for container deployment. PostgreSQL 17 is the CI baseline. The source is Apache-2.0 licensed.

## Quickstart: Core without an Adapter

```sh
npm ci
npm ci --prefix backend/runtime
npm ci --prefix backend
npm ci --prefix frontend
npm run release:openapp -- config/core.release.json /tmp/openapp-core-release
```

This compiles the backend and frontend and exports a verified deployment directory. It does not start services or copy local databases. Follow [first installation](first-install.en.md) to configure fresh storage, build images, start the control plane and bootstrap the first administrator. The home page explains that no Adapter is configured and links to `/control`; application lifecycle operations remain unavailable until an Adapter is composed.

## Add an application

Start with the [end-to-end two-user tutorial](adapter-tutorial.en.md).
It creates independent application and Adapter repositories, installs the SDK,
builds a composition and verifies real user isolation and restart persistence.
`npm run test:tutorial` executes the same marked commands from that document
against a fresh local Docker deployment and stops only its own resources afterward.

Try the runnable [Plain Web example](../examples/plain-web/README.md), then implement an independent repository using the [public contracts](../packages/contracts/README.md) and [Adapter guide](adapter-development.en.md). A catalog can include multiple Adapters; the exporter checks IDs, versions, runtime files and registration conflicts. Backend plugins run in the Core process; this is not a security sandbox.

For implementation details, see the [UI/logic source map](adapter-source-map.en.md), [browser protocol](adapter-ui.en.md), [backend capabilities](adapter-backend.en.md), and copyable [email-code login UI](../examples/email-code-ui/README.md). Custom browser views cover workspace login and the control login SSO region; arbitrary administration pages or menus are not extension points.

```sh
npm run release:openapp -- /path/to/adapter/config/openapp.release.json /tmp/openapp-composed
# Official exports additionally require clean, independent component repositories:
npm run release:openapp -- /path/to/adapter/config/openapp.release.json /tmp/openapp-official --official
```

Release bundles contain compiled JavaScript, frontend assets, Dockerfiles, configuration templates, source provenance and file checksums. Updating a control-plane bundle does not automatically update application runtime images or user instances. See [composition](composition-release.en.md) and [server deployment and migration acceptance](plugin-catalog-release.en.md).

See [contributing](../CONTRIBUTING.md), [security](../SECURITY.md), [support](../SUPPORT.md), [changelog](../CHANGELOG.md) and [third-party notices](../THIRD_PARTY_NOTICES.md). CI runs unit, migration, real Docker, clean-install and security checks; a CI pass is not a substitute for rehearsing a specific production migration.
