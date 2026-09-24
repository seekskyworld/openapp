# Compile and compose a release

[English docs](README.en.md) · [简体中文](composition-release.md)

Maintain Core and each Adapter independently. Composition compiles their code,
validates registrations and produces one verifiable control-plane directory.
It does not build/update business images, change databases or start user instances.

Use Node.js 24 LTS. From Core install with `npm ci`, then `npm ci --prefix backend/runtime`,
`npm ci --prefix backend` and `npm ci --prefix frontend`. Install each Adapter's
locked dependencies separately. Run builds/export tests serially: they share dist.

## Public SDK delivery

Do not assume `@openapp/contracts` is published in the npm registry:

```sh
npm run release:sdk -- /absolute/path/new-sdk-output
cd /absolute/path/new-sdk-output
shasum -a 256 -c SHA256SUMS
cd /absolute/path/your-adapter
npm install --save-dev /absolute/path/new-sdk-output/openapp-contracts-0.2.0.tgz
npm test
```

Use a fixed trusted release URL or published version for shared builds; regenerate
and commit the Adapter lockfile. Do not depend on Core's private source or local
workspace symlinks. Public entry points are `@openapp/contracts`,
`@openapp/contracts/ui` and `@openapp/contracts/runtime-context`.

## Composition catalog

Create a JSON catalog, keeping secrets out of it:

```json
{
  "schemaVersion": 1,
  "defaultAppId": "app-a",
  "compatibilityMode": false,
  "plugins": [
    { "id": "app-a", "source": "../app-a-adapter", "version": "1.0.0" },
    {
      "id": "app-b",
      "source": "../app-b-adapter",
      "version": "2.0.0",
      "environment": { "APP_LABEL": "App B" }
    }
  ]
}
```

Paths resolve relative to the catalog. Each plugin needs a build script,
`dist/index.js`, a valid public manifest and an exactly matching package/manifest/catalog
version. IDs must be unique. Registration conflicts abort export. environment is
non-sensitive per-plugin configuration, copied into the factory host without
changing other plugins' environment. Credentials belong in server configuration.

Bundle third-party runtime dependencies into dist. Only Node built-ins and the
host-provided public contracts may remain external. The exporter rejects other
unbundled runtime dependencies. Optional runtime/build materials and assets must
pass their validators. All backend plugins share one trusted Node.js process.

```sh
npm run release:openapp -- /absolute/path/plugins.json /absolute/path/new-release
node /absolute/path/new-release/verify.mjs
```

Use a nonexistent output directory; export never merges into an old bundle. It
compiles Core and all plugins, tests the real registry, copies namespaced browser
assets, creates runtime plugins.json and writes file checksums/provenance.
App source stays in its own image. Modern authUi does not require legacy mode.

Pure Core uses `config/core.release.json`: empty plugins, compatibilityMode=false,
no application execution or Docker Socket Proxy. Do not accidentally use that
catalog when intending to deploy an application.

## Official releases and checks

Add `--official` only after Core and every Adapter are committed and clean,
including untracked files. Export compares sources before/after compilation to
reject concurrent edits. Development exports permit dirty sources but are labeled
development. source-provenance.json records versions, Git SHAs, dirty flags and
source digests, without developer paths or remote URLs. release-manifest.json
covers compiled files, scripts, provenance and dependency/license records.

Run `npm run check:quality`, `npm run test:sdk`, `npm run test:release`,
`npm run test:deployment`, `npm run test:profiles` and `npm run test:secrets`.
Release changes also need `npm run test:clean-install`; new integrations need the
two-user lifecycle and persistence acceptance in the tutorial. Database/runtime
changes require isolated PostgreSQL/Docker regression. Record the tested versions
and any production migration chain separately. Checksums are not signatures.

Transfer only the complete exported directory, including hidden files, and follow
[server deployment](plugin-catalog-release.en.md). Do not transfer the whole
development workspace or local credentials. After either Core or Adapter changes,
regenerate the matching bundle; commit/pull alone does not update a server.
