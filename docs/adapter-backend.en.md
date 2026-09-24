# Adapter backend capabilities

[Development guide](adapter-development.en.md) · [简体中文](adapter-backend.md)

Use public `@openapp/contracts` 0.2.x with manifest API v2. The authoritative
signatures are [index.ts](../packages/contracts/src/index.ts) and
[build.ts](../packages/contracts/src/build.ts). Default-export a synchronous
`OpenAppAdapterFactory(host)` returning a manifest and required capabilities.
Perform network calls inside capability methods, not module import or factory creation.

## Host and ownership

`host.environment` is read-only configuration. `host.artifacts` provides controlled
image operations. `runCommand` and `buildScriptPath` are optional injections; do not
assume they exist. The historical releaseInspector host field does not provide a
default application-package parser. Bundle third-party runtime dependencies in dist;
use only public contracts, Node built-ins and your own code. Do not access Core's
private database or Docker client. Keep credentials out of manifests and logs.

| Factory result               | Purpose                                                           |
| ---------------------------- | ----------------------------------------------------------------- |
| manifest (required)          | Identity/version, entry, authentication and workload declarations |
| authProvider                 | External identity verification and backend credential grants      |
| authHandoff                  | Application Cookies, login/logout and proxy policy                |
| buildProfile / buildStrategy | Build declarations and actual executable strategy                 |
| releaseInspector             | Package inspection and optional historical field projection       |
| compatibility / legacy       | Optional historical protocols and migration evidence              |

## Identity and session handoff

| Provider method                                                 | Contract                                                                       |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| id / presentation                                               | Provider identity and optional public label/icon/challenge/fields/capabilities |
| sendEmailCode(email)                                            | Promise of `{ providerData?, isNewUser? }` or void                             |
| login({ email, code, providerData? })                           | Verified `{ identity, credentialGrant? }`                                      |
| mapError(error, operation)                                      | email-code/login → public `{ status, code }` or undefined                      |
| validateCredentialGrant / revokeCredentialGrant / revokeSession | Optional lifecycle methods; use public parameter types                         |

Identity includes provider, subject, email and optional displayName/isNewUser.
Obtain subject from a verified upstream identity, never trust a form-supplied ID.
Map upstream errors to stable public codes; do not expose tokens or stacks. Core
owns account linking, role authorization and Portal sessions. Providers cannot
grant themselves administrator roles.

`authHandoff` supplies appId, managedCookieNames, onLogin, onLogout and proxyOptions,
with optional acceptsCredentialGrant/hasSession. Login/logout produce Set-Cookie
strings. Specify names, domain, path, lifetime and revocation deliberately. Core
checks ownership and invokes handoff; it does not forward all Portal Cookies or
upstream tokens by default. The [browser API](adapter-ui.en.md) uses generic
external-auth routes restricted to the current App's Provider.

## Build slots and Revisions

Declare `manifest.build` with strategyId, revision, runtimeContract, imagePrefix
and packageRequirements. Do not declare the internal buildStrategies array. The
factory's buildStrategy id/revision must match the declaration. A buildProfile
alone does not create an executable builder.

Slots are application-defined, not fixed frontend/backend pairs.
`validateBuildPackageRequirements` accepts 1–32 unique slots with allowed extensions,
required/optional status and size limits. Omit build for existing-image applications.
Core renders generic upload/replacement controls from declarations and snapshots.

BuildStrategyAdapter optionally implements inspectPackage/inspectPackages and must
implement execute. Input includes build, appVersion, optional standaloneSource,
releaseRoot, AbortSignal and async report(progress, stage). Return imageReference,
imageId and optional cleanup. Respect cancellation, report progress and clean failed
or uncommitted artifacts. Trusted Adapter code selects commands/package layout;
database records and uploads must not supply arbitrary executable commands.

Core manages hashes, tasks, immutable Revisions and activation concurrency.
In replacementPackageIds, omitted means inherit, a string replaces the slot, and
null removes an optional slot. Required slots cannot be removed. Empty ordinary
uploads are rejected; a revision with all optional slots removed still requires
a successfully built and bound artifact before activation.

Existing-image integrations can POST `/api/admin/apps/:appId/image-imports` with
imageReference and an `idempotency-key` header. Response is 202/operationId. Reuse
the key only for retries of the same request; changed input conflicts. A loaded
execution contract is required. The host resolves the immutable image, validates
and runs it, then creates a candidate Revision. Import does not activate it or
upgrade existing instances; perform those steps explicitly with concurrency checks.

Historical strategy rows are descriptive data, not executable modules. Inspect
`executable` and `unavailableReason`; missing implementation/version mismatch or
control-plane-only mode disables upload/build even if an old row is enabled.

## Runtime and historical data

`manifest.workload` defines environment kind, access mode and health path.
`workload.runtime` specifies image, user, port, commands, storage, resource labels,
configuration keys and reserved environment variables. Core does not infer them
from the App name. See the working [Notes profile](../examples/notes-adapter/src/profile.json).

Runtime contextFiles explicitly lists build materials; validate using
`@openapp/contracts/runtime-context`. Reject unexpected files, symlinks, traversal
and secrets. Optional recoveryCommand is executable plus arguments, accompanied
by lockRecoveryEnvironment mappings for containers/hosts/recoveryId. Omit both
if unused. Core verifies ownership/stopped containers before mounting a Volume;
recovery failure blocks destructive follow-up. It does not guess a shell/interpreter.

For historical upload protocols, releaseInspector.uploadRequirements and
inspectUpload convert named inputs to generic package snapshots.
legacyPackageColumns maps old column names to slots; the host performs declared,
idempotent backfill and preserves old columns. Do not overwrite generic schema
fields or add product columns for new apps. Complete backfill before unloading the
required Adapter. Compatibility projection is not a backup or recovery test.

## Tests and version changes

Test factory/packaging, real Provider failures and revocation, build cancellation,
runtime validation, HTTP authorization, both login views and two-user persistence.
Historical migrations need isolated copies of the actual old database and Volumes,
data/ownership comparisons, lifecycle tests and final task states. A health response
or successful compile is insufficient.

Incompatible contracts require updating affected Adapters and recomposing with
matching Core. Multiple plugins need unique application/registration identities.
They share one backend process; API isolation does not provide fault/security
sandboxing. See [composition](composition-release.en.md).
