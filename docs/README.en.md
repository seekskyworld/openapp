# OpenApp documentation

[Project overview](../README.md) · [简体中文](README.md)

OpenApp Core owns accounts, authorization, workspaces, execution, proxying and
release orchestration. An independent Adapter supplies application-specific
identity, runtime declarations, optional SSO/UI and build recipes. The application
repository owns the actual business services and pages.

## Start here

1. Read [integration requirements and Core-only quickstart](getting-started.en.md).
2. Follow the [complete two-user tutorial](adapter-tutorial.en.md). It creates a
   new application and Adapter, installs the public SDK, compiles, deploys and tests
   real containers, permissions and persistence.
3. Use the references below to replace the example with your application.
4. [Compose a release](composition-release.en.md), then follow
   [server installation and updates](plugin-catalog-release.en.md).

## Implementation references

| Task                                                         | Guide                                               |
| ------------------------------------------------------------ | --------------------------------------------------- |
| Repository layout, SDK versions, capabilities and acceptance | [Adapter development](adapter-development.en.md)    |
| Identify which repository owns a page or feature             | [UI and logic source map](adapter-source-map.en.md) |
| Workspace login and administrator SSO views                  | [Browser API](adapter-ui.en.md)                     |
| Identity, Cookies, build slots, runtime and migrations       | [Backend capabilities](adapter-backend.en.md)       |
| Multiple plugins, compilation and provenance                 | [Composition](composition-release.en.md)            |
| Fresh installation, persistent configuration and upgrades    | [Deployment](plugin-catalog-release.en.md)          |

Public types live in [contracts](../packages/contracts/src/index.ts),
[browser contracts](../packages/contracts/src/ui.ts) and
[build contracts](../packages/contracts/src/build.ts). Type definitions are the
authoritative signatures; Core implementation files are not importable plugin APIs.

Runnable code is in [notes-app](../examples/notes-app),
[notes-adapter](../examples/notes-adapter) and [plain-web](../examples/plain-web).
[adapter-template](../examples/adapter-template) is a declaration skeleton, not a
complete runnable application. [email-code-ui](../examples/email-code-ui) supplies
browser views, not an identity service. Use the English tutorial for commands.

## Maintenance and limits

See [contributing](../CONTRIBUTING.md), [security](../SECURITY.md),
[governance](../GOVERNANCE.md) and [changelog](../CHANGELOG.md).
The existing detailed [backup/restore runbook](operations/backup-restore-runbook.md)
and [local development reference](local-development.md) are in Chinese; the English
deployment guide includes the required upgrade/rollback acceptance checklist.

Docker/OrbStack are supported today. A workspace currently runs one application
container with one HTTP entry, not arbitrary Compose stacks. Adapter modules run
trusted code in the Core process. Separate source repositories are not a sandbox.
External databases and object stores need their own per-user boundaries.
