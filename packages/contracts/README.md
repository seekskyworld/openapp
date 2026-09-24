# @openapp/contracts

本版本采用 Apache License 2.0，完整条款见 [LICENSE](LICENSE)。历史版本已授予的 MIT 权利保持有效。

The versioned boundary between the OpenApp control plane and application
adapters. It contains serializable manifests and narrow authentication,
handoff, build, and release-inspection interfaces. It does not import Portal,
Docker, PostgreSQL, or any application implementation.

For a complete independent repository workflow, see the [Adapter development guide](../../docs/adapter-development.md) and [composition build guide](../../docs/composition-release.md) in the Core source repository.

Detailed references: [backend capabilities](../../docs/adapter-backend.md), [browser UI protocol](../../docs/adapter-ui.md), and [UI/logic source map](../../docs/adapter-source-map.md). Browser types are exported from `@openapp/contracts/ui`: AuthUiUser, AuthUiLoginProps, AuthUiHost, AuthUiExtension and AuthUiFactory. Pass your React API/component types as generics; the backend SDK does not depend on React. Public build strategy ownership is declared by `manifest.build.strategyId`, not Core's internal `buildStrategies` registration field.

Until a registry release is available, use the [verified tarball delivery](../../docs/composition-release.en.md#public-sdk-delivery). `npm run release:sdk -- /tmp/new-sdk` from Core produces a package and SHA256SUMS; `npm run test:sdk` verifies independent installation, public imports and the TypeScript Adapter template.

## Release

The 0.2.x contract uses `manifest.apiVersion = "v2"`. It replaces fixed release
package inspection methods with declared upload requirements and generic package
snapshots. Core rejects v1 adapters before registration; rebuild and release the
Core and adapter together. Authentication UI's separate numeric API remains 1.

Build and publish this package from the Core repository, then update an
adapter's `@openapp/contracts` dependency to the released semver range:

```sh
npm run build
npm pack --dry-run
npm publish --access public
```

An adapter must be installable from the published package in a clean directory;
it must not use a sibling-repository `file:` dependency or a workspace link.

## Compatibility metadata

Authentication fields declare an ID, label, kind and optional required/secret/length
constraints. Core recognizes `email` and `verification_code`; other lowercase
identifier kinds are opaque to Core and use text input in its fallback form.
Custom widgets, registration conditions and code-format validation belong to the
Adapter/Provider. A custom kind never enables executable browser content. This
also preserves older field-kind identifiers without embedding their semantics
in the platform. Core bounds verification codes to 256 characters; Providers
must still validate the actual challenge and its lifetime.

`AppAdapterManifest.compatibility` is the only public place for an adapter to
declare legacy aliases, safe user-facing error messages, or a migration evidence
descriptor. `OpenAppAdapter.compatibility` may repeat the same value, but the
Core bridge rejects a mismatch. The metadata is declarative: it cannot contain
SQL, commands, secrets, token values, or arbitrary HTTP behavior.

`validateAdapterCompatibility` enforces bounded IDs and paths, rejects duplicate
aliases and sensitive error keys, and accepts only a 64-digit SHA-256 checksum
(with an optional `sha256:` prefix). A migration descriptor is an evidence index,
not an instruction to execute a migration. Adapters without a real migration
definition must omit `migration` instead of inventing a checksum.

## Legacy compatibility island

`OpenAppAdapter.legacy` is an optional, adapter-owned compatibility island for
old routes, auth aliases, runtime profiles, catalog projections, and migration
evidence. `validateAdapterLegacy` checks path, identity, cookie, runtime, and
function shapes at the trust boundary. The Core `LegacyCompatibilityHost` may
invoke only the declared pure projections and route resolver; it never receives
an HTTP request, database connection, Docker client, SQL statement, or shell
command from an adapter. A legacy Provider/handoff must remain tied to the
adapter's normal Provider/handoff, and a plain App can omit the entire field.
