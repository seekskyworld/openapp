# From a single-user app to two independent workspaces

[English documentation](README.en.md) · [简体中文](adapter-tutorial.md)

This tutorial creates **two independent repositories**, builds a real Notes application and
an Adapter, compiles an OpenApp deployment directory, and tests two real users. The application
keeps its single-user business logic. OpenApp supplies accounts, access checks, containers and
persistent volumes. No external identity service is required.

Use Node.js 24 LTS, npm, Git, Bash, Docker Engine or OrbStack, and Docker Compose v2.
Docker must be running; allow registry and npm network access. Run from a Core checkout,
not from an exported deployment directory. This creates an isolated local experiment,
not an upgrade of an existing service. Docker/OrbStack are implemented; Daytona and
Kubernetes are not implemented Providers.

## 0. Prepare the environment

Run all commands in the same shell:

```bash
export CORE_ROOT="$PWD"
export LAB_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/openapp-tutorial-XXXXXX")"
export TARGET_PLATFORM="$(docker version --format '{{.Server.Os}}/{{.Server.Arch}}')"
node --version
docker compose version
printf 'Workspace: %s\nPlatform: %s\n' "$LAB_ROOT" "$TARGET_PLATFORM"
```

`TARGET_PLATFORM` should be `linux/amd64` or `linux/arm64`. Use the same platform for
the application and control-plane images. Record `LAB_ROOT`; restore these variables
if you change terminals.

```text
Core checkout/              Generic source; CORE_ROOT
Experiment/                LAB_ROOT
├── notes-app/             Independent business application repository
├── notes-adapter/         Independent integration repository
├── sdk/                   Compiled public SDK and checksums
├── release/               Generated control-plane deployment directory
├── data/                  This experiment's PostgreSQL, logs and artifacts
└── tutorial-*.json        Experiment identity, private accounts and results
```

```bash
# tutorial:dependencies
cd "$CORE_ROOT"
npm ci
npm --prefix backend/runtime ci
npm --prefix backend ci
npm --prefix frontend ci
```

## 1. Create the application and Adapter repositories

```bash
# tutorial:copy
cd "$CORE_ROOT"
cp -R examples/notes-app "$LAB_ROOT/notes-app"
cp -R examples/notes-adapter "$LAB_ROOT/notes-adapter"
cp LICENSE "$LAB_ROOT/notes-app/LICENSE"
cp LICENSE "$LAB_ROOT/notes-adapter/LICENSE"
git -C "$LAB_ROOT/notes-app" init
git -C "$LAB_ROOT/notes-adapter" init
```

`notes-app/frontend/` contains HTML, JavaScript and CSS. `backend/server.mjs` serves
the page, `GET/PUT /api/note`, and `GET /health`. Its Dockerfile places frontend and
backend in **one application image**, listens on port 8080, runs as `node`, and
writes `/data/note.json`.

The default workspace URL is `/instances/<id>/ui/`. The proxy strips
`/instances/<id>` but **preserves `/ui/`**. This app supports a deployment setting
`BASE_PATH=/ui`, producing `/ui/` and `/ui/api/note`; health remains `/health`.
The frontend uses `./api/note`, `./app.js` and `./style.css`. Both frontend and
backend must support the base path. Root-absolute `/api/note` would target OpenApp's
API instead. This is deployment configuration, not newly added tenant business logic.
The application has no authentication and must only be exposed through the platform proxy.

## 2. Install the public SDK and compile the Adapter

Do not assume the SDK version is published to npm. Build and verify a tarball from
the selected Core version, then install it into the separate Adapter:

```bash
# tutorial:sdk
cd "$CORE_ROOT"
npm run release:sdk -- "$LAB_ROOT/sdk"
cd "$LAB_ROOT/sdk"
shasum -a 256 -c SHA256SUMS
cd "$LAB_ROOT/notes-adapter"
npm install --save-dev "$LAB_ROOT/sdk/openapp-contracts-0.2.0.tgz"
npm test
```

Expect checksum `OK`, passing tests, a new lockfile, `dist/index.js` and
`dist/profile.json`. Subsequent installs use `npm ci`. For shared builds, replace
the local tarball dependency with a fixed release URL or published registry version
and commit the regenerated lockfile. Do not distribute your temporary local path.

Compare `src/index.ts` and `src/profile.json` against the application:

| Declaration                                             | Required relationship                                                  |
| ------------------------------------------------------- | ---------------------------------------------------------------------- |
| manifest.id, entry.id, authHandoff.appId                | `notes-demo`; identical application identity                           |
| manifest.version, package.json, release catalog version | `1.0.0`; exact version match                                           |
| auth.providerId / protocol                              | `none`; users still authenticate with local OpenApp accounts           |
| workload.runtime                                        | The application's actual launch and persistence contract               |
| catalogBootstrap                                        | Registers the initial application/image in a fresh database            |
| authHandoff                                             | No platform Cookie forwarding or external credential grant             |
| defaultImage                                            | `openapp-notes-demo:1.0.0`, available on the target Docker Engine      |
| containerPort / containerUser                           | `8080` / `node`; listen on `0.0.0.0`                                   |
| entrypoint / command                                    | `/app/start.sh` / `node /app/backend/server.mjs`; match image metadata |
| healthPath / storageMountPath                           | `/health` / `/data`; writable by the container user                    |
| contract                                                | `notes-demo-v1`; consistent with workload and catalog declarations     |

This integration uses an existing image, so it needs no `buildStrategy`, upload
slots or Adapter `runtime/` build directory. SSO, custom login UI and legacy
migrations are optional, not requirements for every Adapter.

## 3. Build the application image

```bash
# tutorial:app-image
cd "$LAB_ROOT/notes-app"
docker build --platform "$TARGET_PLATFORM" -t openapp-notes-demo:1.0.0 .
docker image inspect openapp-notes-demo:1.0.0 --format '{{.Os}}/{{.Architecture}} {{json .Config.Entrypoint}} {{json .Config.Cmd}}'
```

Check platform, Entrypoint and Cmd against step 2. This image runs users' notes;
the two images built in step 5 run the OpenApp control plane.

## 4. Compile the composition

The Adapter's `openapp.release.json` selects `notes-demo`. Its `source: "."` is
resolved relative to that catalog, not the shell's current directory.

```bash
# tutorial:compose
cd "$CORE_ROOT"
npm run release:openapp -- "$LAB_ROOT/notes-adapter/openapp.release.json" "$LAB_ROOT/release"
node "$LAB_ROOT/release/verify.mjs"
```

Expect `openapp-control-plane verified`. The exporter compiles Core and Adapter,
validates registration and produces `release/core/`, `release/openapp-notes-demo-adapter/`,
Docker build instructions and file fingerprints. Business source stays in its own
image; exporting does not rewrite it.

Always export into a **new, nonexistent directory**. Regenerate after source changes;
do not edit generated code. This experiment is a development export because its new
repositories are not committed. `--official` requires clean, committed, independent
source repositories. Checksums are integrity evidence, not a digital signature.

## 5. Configure and start the control plane

```bash
# tutorial:control-images
cd "$LAB_ROOT/release"
bash build-images.sh
docker pull --platform "$TARGET_PLATFORM" node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
```

Expect `openapp-portal-backend:release-<fingerprint>` and
`openapp-frontend:release-<fingerprint>`. The separate Node image supports health probes.

```bash
# tutorial:configure
cd "$CORE_ROOT"
node scripts/tutorial/configure.mjs "$LAB_ROOT/release" "$LAB_ROOT/data"
```

The helper accepts only new data and configuration paths. It generates private
database/CLI credentials, assigns artifacts UID/GID 10001, reads the Docker socket
GID and chooses unused local ports. Record its printed home and `/control` URLs.
It does not modify existing deployments. Short random `oat-…` resource prefixes
keep generated container names within the 63-character DNS label limit.

Review `release/core/.env`; never publish its credentials:

| Setting                                    | Expected value                   |
| ------------------------------------------ | -------------------------------- |
| COMPOSE_PROJECT_NAME                       | Unique `openapp-tutorial-…`      |
| Runtime resource prefixes                  | Unique short `oat-…` values      |
| OPENAPP_DATA_ROOT                          | Absolute `LAB_ROOT/data`         |
| OPENAPP_CONTROL_PLANE_ONLY                 | `false`                          |
| OPENAPP_ADAPTER_CATALOG                    | `/app/backend/plugins.json`      |
| OPENAPP_RELEASE_PATH                       | `notes-demo`                     |
| AUTH_PROVIDER / OPENAPP_COMPATIBILITY_MODE | `none` / `false`                 |
| BACKEND_IMAGE / FRONTEND_IMAGE             | Fingerprinted images built above |
| TARGET_PLATFORM                            | Same as the business image       |
| PUBLIC_ORIGIN / PORTAL_PUBLIC_BASE_URL     | Same local URL, including port   |

Start **four** services for the composition, including the socket proxy:

```bash
# tutorial:start
cd "$LAB_ROOT/release/core"
docker compose --env-file .env config --quiet
docker compose --env-file .env up -d --no-build --wait --wait-timeout 120 postgres docker-socket-proxy portal-backend frontend
docker compose --env-file .env ps
```

Then initialize the first administrator:

```bash
# tutorial:bootstrap
cd "$LAB_ROOT/release/core"
bash bootstrap-admin.sh
```

Enter your administrator email/password interactively. Initialization refuses to
run if any super administrator already exists. Automated replay injects a random
test password through private environment variables, not a real account.

## 6. Verify access, isolation and persistence

```bash
# tutorial:verify
cd "$CORE_ROOT"
node scripts/tutorial/verify.mjs "$LAB_ROOT/release"
node "$LAB_ROOT/release/verify.mjs"
```

The verifier accepts only a marked local tutorial deployment and refuses repeated
test-account creation. Expect all checks to pass:

1. Management/readiness endpoints and local authentication work.
2. Alice and Bob get separate real application containers.
3. HTML, JS, CSS and note APIs work; different notes do not overwrite each other.
4. Anonymous access and cross-user reads/starts are denied; normal users cannot administer.
5. Notes survive stopping and starting each instance.
6. Login and notes still work after restarting the control-plane backend.

Results are in `tutorial-acceptance.json`. Random account passwords are stored only
in `tutorial-accounts.json` with mode 0600, outside the release. Use separate browser
profiles for the two users; verify login, editing, saving and refreshing. The
administrator can inspect both instances from `/control`.

Optional automated browser checks, once after the API checks (they update test notes):

```bash
npm install --prefix "$LAB_ROOT/browser-tools" playwright@1.63.0
node "$LAB_ROOT/browser-tools/node_modules/playwright/cli.js" install chromium
node "$CORE_ROOT/scripts/tutorial/browser.mjs" "$LAB_ROOT/release"
```

This clicks through login, save and refresh in two sessions and records screenshots
and `tutorial-browser.json` outside the release. On Linux, install Playwright's
requested browser system dependencies if necessary. A pass covers this example,
not your application's SSO, external database or historical migration.

### Replay the document automatically

Run `npm run test:tutorial -- --lang=en` from Core. It executes the ten marked
commands above, checks that business sources remain unchanged, and stops only its
own services on success or failure. English and Chinese marked commands must match.
CI replays the English document. `--lang=zh-CN` selects Chinese.

Use `--keep-running` to retain running services for browser acceptance, then stop
them as below. Browser checks are optional and are not part of automated replay.
Success requires `tutorial-progress.json` status `passed` and the acceptance report;
compilation alone is not runtime acceptance.

## 7. Stop the experiment or deploy elsewhere

```bash
cd "$CORE_ROOT"
node scripts/tutorial/stop.mjs "$LAB_ROOT/release"
```

This stops this experiment's dynamic user instances and removes its four
control-plane containers and networks. It preserves PostgreSQL data and user
Volumes. Restart the control plane with step 5's start command. Compose alone
does not stop dynamically created application containers. Do not run a global
prune. `tutorial-state.json` records the experiment's resource identity.

For a fresh server, transfer the complete verified `release/` separately from the
application image. Make the exact image/platform available to the target Docker
Engine. Configure your server's domain, credentials, data directories, socket GID
and ports using the [server deployment guide](plugin-catalog-release.en.md).
The tutorial configuration helper is local-only. Public access needs TLS and
secure Cookies. Existing-data upgrades additionally require backup/restore and
migration rehearsals; never replace a live database with this experiment's empty one.

## 8. Adapt your own application

| Application requirement                      | Integration work                                                                                                         |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Backend can serve compiled frontend files    | Package both into one application image                                                                                  |
| Vite or another frontend development server  | Build production assets; do not deploy the development server                                                            |
| Frontend/backend require separate containers | Current runtime uses one application container and HTTP entry per workspace; arbitrary business Compose is not supported |
| Root-absolute URLs or fixed domains          | Configure asset/API base paths for the instance proxy                                                                    |
| External database/object store               | Give each instance separate data boundaries and credentials                                                              |
| Only OpenApp authentication                  | Keep `none`, no credential handoff, no public application port                                                           |
| External identity or application login       | Implement and test [Provider/handoff](adapter-backend.en.md)                                                             |
| Branded workspace login or control SSO       | Implement two [browser views](adapter-ui.en.md); retain platform branding                                                |
| Upload packages and build images in the UI   | Add a buildStrategy, named slots and build materials                                                                     |

Change IDs, image, contract, port, launch command and storage path consistently,
then repeat composition and acceptance. Renaming a display label is not adaptation.
`catalogBootstrap` initializes a new catalog; subsequent image updates require a
candidate Revision, validation, activation and explicit instance upgrades.

## Troubleshooting

| Symptom                              | Check                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------ |
| SDK registry 404                     | Install the generated SDK tarball; do not assume publication             |
| ID/version mismatch                  | Manifest, package and release catalog must agree                         |
| Home says no Adapter                 | Use the Notes catalog, not `config/core.release.json`; re-export         |
| Runtime unavailable                  | Socket Proxy health, DOCKER_GID and target Engine connectivity           |
| Docker address pools exhausted       | Stop your old experiments with their scoped helper                       |
| runtime_image_platform_invalid       | Inspect/rebuild for TARGET_PLATFORM                                      |
| Page loads but API/assets return 404 | Trailing `/`, relative resources and backend base path                   |
| origin_not_allowed                   | Exact PUBLIC_ORIGIN, including port; localhost differs from 127.0.0.1    |
| Unexpected files during verification | Only `core/.env` is exempt; keep logs, accounts and data outside release |

Next: [Adapter reference](adapter-development.en.md), [source map](adapter-source-map.en.md),
[composition](composition-release.en.md). A Revision is an immutable application
release snapshot, not a Git commit or an Adapter package version.
