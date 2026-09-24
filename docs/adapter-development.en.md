# Develop an independent Adapter

[English docs](README.en.md) · [简体中文](adapter-development.md)

Complete the [two-user tutorial](adapter-tutorial.en.md) first. This reference
describes how to extend that working integration. Existing-image applications do
not need SSO, package upload/build strategies or historical compatibility.

## Repository and SDK

```text
sample-adapter/
├── package.json
├── package-lock.json
├── tsconfig.json
├── src/index.ts
├── assets/              Optional browser modules, styles and icons
├── runtime/             Optional image build materials and profile.json
├── deployment/build/    Optional trusted build scripts
├── tests/
└── README.md
```

Use Node.js 24 LTS, ESM and a build script producing `dist/index.js`. Start from
[notes-adapter](../examples/notes-adapter), which compiles independently against
the public SDK. Install the matching SDK tarball as shown in the tutorial if that
version is not on npm. For shared builds, use a fixed release URL/registry version
and commit the lockfile; do not use sibling-source imports or workspace links.

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

This registry-based example assumes the version exists; otherwise replace its
development dependency with your verified SDK artifact before installing.

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

Default-export an `OpenAppAdapterFactory`: synchronously receive a public host
and return a manifest plus implemented capabilities. `manifest.id`, `entry.id`
and catalog plugin ID must agree; package, manifest and catalog versions must
match. Contracts 0.2.x use manifest API `v2`; browser authUi uses numeric API `1`.
These are separate version axes. Old v1 plugins must be adapted and recompiled.

## Ownership and extension points

| Adapter capability           | Adapter owns                                                 | Core owns                                      |
| ---------------------------- | ------------------------------------------------------------ | ---------------------------------------------- |
| manifest                     | App identity, entry and workload declarations                | Identity/version/conflict validation           |
| authProvider                 | Verified external identities and public error mapping        | Account linking, sessions, roles               |
| authHandoff                  | Application Cookies, login/logout and proxy policy           | Ownership and controlled invocation            |
| runtime                      | Launch, port, health, storage and optional recovery contract | Container lifecycle and resource ownership     |
| buildStrategy / buildProfile | Package interpretation and executable build recipe           | Uploads, hashes, tasks and immutable Revisions |
| assets / authUi              | Application workspace login and control SSO views            | Mounting, request host and platform branding   |
| compatibility / legacy       | Optional old protocol/data projections                       | Generic compatibility host and validation      |

Omit unused capabilities. Core keeps the administrator login's left OpenApp brand,
local password form and administration pages. There is no arbitrary menu/page
injection API. Business pages remain in the application's image. See the
[source map](adapter-source-map.en.md) for exact locations.

For local authentication, declare `auth.providerId=none` and `entry.challenge=none`.
Core provides normal account login/registration; successful SSO does not grant
administrator privileges. Default business entry `/instances/<id>/ui/` forwards
`/ui/` to the application, so configure both resource and API base paths.

## Optional features

Use [backend capabilities](adapter-backend.en.md) for Provider methods, Cookie
handoff, build execution, named slots, existing-image imports and migration rules.
Use [browser API](adapter-ui.en.md) for custom login views. The copyable email-code
example only implements UI; you must supply a real backend identity provider.

Production code depends only on public contracts, Node built-ins and its own
modules. Bundle other runtime dependencies into `dist`; the exporter rejects
unbundled third-party `dependencies`. Never import Core's private database, Docker
client or test host. Keep credentials in server configuration, outside manifests,
assets and release catalogs.

Declare protected application environment keys explicitly in `reservedEnvironment`.
The host also protects its own configuration keys, `configEnvironmentKey`, recovery
mapping and Provider-injected keys. Protection is by exact key, not name suffix.
Application lock recovery requires both `recoveryCommand` (executable plus arguments)
and `lockRecoveryEnvironment` mappings for containers/hosts/recoveryId. Omit both
when unused. Old `recoveryScript` is rejected. The host does not guess an interpreter
or run these declarations through a shell.

## Acceptance and release

1. Compile independently and inspect package contents: dist, optional assets/build
   materials and required licenses. No private-source dependency is allowed.
2. Test the real factory, identity/version errors and every implemented capability:
   Provider failures, logout/revocation, build cancellation and failure cleanup.
3. For browser extensions test both views, send failures, existing accounts,
   additional fields, resend/change-email, stale responses and keyboard access.
4. Compose with matching Core and run the generated `verify.mjs`. Test IDs, browser
   assets and backend registration together; test each supported compatibility mode.
5. Run two real users through access, cross-user denial, stop/start and persistence.
   If migrating, use isolated copies of the actual old database and Volumes and
   verify lifecycle, restore and final upgrade-task states. Record untested areas.

Then [compose](composition-release.en.md) and [deploy](plugin-catalog-release.en.md).
Core or Adapter changes require a new matching control-plane bundle. Business
image updates follow their own candidate/activation/instance-upgrade process.
Committing or pulling source alone does not update a server.

## Troubleshooting

| Symptom                                  | Evidence to inspect                                                             |
| ---------------------------------------- | ------------------------------------------------------------------------------- |
| Custom view missing                      | auth-adapters.json, Provider selection, module path/API and createAuthUi export |
| auth_provider_not_found                  | Backend registration and current App's allowed Provider                         |
| Existing users see registration fields   | Provider challenge/providerData and UI conditions, not isNewUser alone          |
| Historical strategy visible but disabled | executable/unavailableReason, loaded implementation/revision and Runtime        |
| UI unchanged after plugin update         | Recompose and deploy the frontend image too                                     |

Core documentation describes generic contracts. Your Adapter README should explain
its identity service, field rules, branded views, runtime, migration and release
commands. Product-specific acceptance evidence belongs with that Adapter.
