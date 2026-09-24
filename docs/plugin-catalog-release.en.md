# Deploy an OpenApp composition

This guide applies to a generated control-plane bundle. For development commands,
use `docs/adapter-tutorial.en.md` and `docs/composition-release.en.md` in the source
repository. A bundle contains compiled code, not the full development examples.
For a fresh installation without applications, see [Core-only installation](first-install.en.md).

## What is delivered

```text
release/
├── core/                         Backend, frontend, Compose, templates and scripts
│   └── plugins.json              Generated runtime module catalog
├── openapp-app-a-adapter/        Compiled trusted integration
├── openapp-app-b-adapter/        Optional additional integration
├── build-images.sh
├── verify.mjs
├── source-provenance.json
├── third-party/                  Dependency inventory and license texts
└── release-manifest.json
```

Upload the entire directory, including hidden files. Do not upload a developer's
actual core/.env. The server owns its credentials and persistent data. Application
images and live database/Volumes are separate deliverables.

The backend loads `/app/backend/plugins.json` through OPENAPP_ADAPTER_CATALOG,
checks allowed paths, identities, versions and registration conflicts. The catalog
does not grant user permissions. Existing workspaces select their own App ID;
OPENAPP_APP_ID is only the default App. A failed catalog does not fall back to a
built-in plugin. Plugins share the backend process and must be trusted.

Browser extensions are copied to `core/frontend/web/adapter-assets/<id>/` and
registered in auth-adapters.json. Login asset changes require a new frontend image;
changing only the backend plugin cannot update them. Never replace individual
compiled files inside a verified bundle; export a matching composition again.

## Fresh composed installation

Use Node.js 24 LTS for verification, Docker Engine/OrbStack and Compose v2.
Prepare the application's exact image on the target Engine, matching the declared
platform, user, startup command, port, health endpoint and storage path.

From the transferred release directory:

```sh
node verify.mjs
bash build-images.sh
cp core/.env.production.example core/.env
chmod 600 core/.env
```

The build prints fingerprinted backend/frontend image names; set BACKEND_IMAGE
and FRONTEND_IMAGE to them. Building images does not switch running services.
Review all core/.env settings, particularly:

| Setting                                     | Deployment requirement                                                    |
| ------------------------------------------- | ------------------------------------------------------------------------- |
| COMPOSE_PROJECT_NAME                        | Unique stable deployment identity                                         |
| OPENAPP_DATA_ROOT                           | Absolute persistent data root outside the release directory               |
| POSTGRES_PASSWORD / OPENAPP_ADMIN_CLI_TOKEN | Independent secrets, e.g. from `openssl rand -hex 32`                     |
| PUBLIC_ORIGIN / PORTAL_PUBLIC_BASE_URL      | Correct public origin, including scheme and non-default port              |
| PORTAL_PORT / PORTAL_BACKEND_PORT           | Deliberately chosen bindings; avoid exposing internal management services |
| TARGET_PLATFORM                             | Matches business and control-plane images                                 |
| DOCKER_GID                                  | Group of the Docker socket inside the target Engine host                  |
| OPENAPP_CONTROL_PLANE_ONLY                  | false for application execution                                           |
| OPENAPP_ADAPTER_CATALOG                     | /app/backend/plugins.json                                                 |
| OPENAPP_RELEASE_PATH                        | Artifact subdirectory for this deployment                                 |
| Provider/resource configuration             | Correct image/profile and unique resource prefixes                        |

Keep generated Adapter identity/catalog and compatibility settings consistent with
the selected bundle. Configure required Provider secrets on the server. For a new
data root such as `/srv/openapp-data`, create postgres/data, postgres/init and
frontend/nginx/logs. Create the artifact directory named by OPENAPP_RELEASE_PATH
with UID/GID 10001 ownership. Do not initialize new storage over existing data.

```sh
cd core
docker compose --env-file .env config --quiet
docker compose --env-file .env up -d --no-build --wait --wait-timeout 120 postgres docker-socket-proxy portal-backend frontend
bash bootstrap-admin.sh
docker compose --env-file .env ps
```

Bootstrap asks privately for administrator credentials and refuses if a super
administrator exists. It does not reset passwords. Noninteractive secrets may be
injected as OPENAPP_BOOTSTRAP_SUPER_ADMIN_EMAIL/PASSWORD, never committed.
Schema initialization runs during backend startup.

For public use configure TLS, domain, gateway and secure Cookies using the
provided templates. Starting these four services alone does not establish public
TLS. Keep PostgreSQL and Docker control access private. Verify the actual resolved
Compose configuration before starting; do not publish its secret values.

## Update an existing deployment

1. Record the running release fingerprint, image IDs, Compose project, container
   names, configuration and all database/Volume/artifact mounts. Preserve the old
   verified bundle and images as a rollback point.
2. Back up PostgreSQL, application Volumes and artifacts consistently. Restore them
   into an isolated test environment, not merely list/checksum the archives.
3. Upload the new bundle to a separate directory; run verify and build-images there.
   Merge server settings into its core/.env. Preserve COMPOSE_PROJECT_NAME,
   OPENAPP_DATA_ROOT, original data mounts, runtime resource prefixes, business
   images and existing container identities. Do not reuse local tutorial settings.
4. Rehearse the exact old-to-new migration on copies with the new matching bundle.
   Run migration twice, compare records/ownership, test local/external authentication,
   authorization, business access, stop/start, image upgrade and persistent writes.
5. Inspect resolved Compose against production. Follow your maintenance/write-stop
   plan, take a final consistent backup, and switch only the intended control services:

   ```sh
   cd core
   docker compose --env-file .env up -d --no-deps --no-build --wait portal-backend frontend
   ```

6. Check health/readiness, `/control`, logs, user/instance relationships, app access
   and pending tasks. Keep the old artifacts until acceptance is complete.

The switch command assumes existing PostgreSQL, networks and Socket Proxy remain
compatible and running. If their configuration must change, plan and rehearse that
separately. This bundle has no universal full-service deploy.sh. Updating the
control plane does not activate a new business Revision or upgrade user instances.

Default container names use COMPOSE_PROJECT_NAME. Older names can be preserved with
OPENAPP_POSTGRES_CONTAINER, OPENAPP_PORTAL_BACKEND_CONTAINER,
OPENAPP_FRONTEND_CONTAINER, OPENAPP_DOCKER_SOCKET_PROXY_CONTAINER and
OPENAPP_GATEWAY_CONTAINER. Compare the resolved configuration before switching.

## Migration and rollback acceptance

A successful build or health endpoint is insufficient. Retain evidence of:

- Exact before/after versions, restorable backups and image/artifact digests.
- Database row/content and user/role/tenant/instance ownership comparisons,
  repeated migration, constraints and indexes.
- Authentication, ordinary-user permissions and cross-user business-content denial.
- Restored Volume content, writes surviving instance/backend restart, upgrade-task
  completion and actual business operation.
- Old-release behavior against the supported rollback state and handling of writes
  made after the backup. Restore of an old dump would discard newer writes.

If rollback is needed, stop writes and preserve the latest database/business data
before following the rehearsed restoration or forward-fix plan. Do not blindly
restore an old dump or assume an old executable accepts a new schema. Record
untested areas explicitly. The source repository also includes the detailed
Chinese runbook at `docs/operations/backup-restore-runbook.md`.

## Verification and operations

`node verify.mjs` rejects missing, modified or unexpected files, except local
core/.env and ignored Finder metadata. Logs/accounts/data belong outside release.
source-provenance.json identifies component sources without developer paths;
checksums do not authenticate an untrusted distributor.

Use core/status.sh, logs.sh and stop.sh for the control plane. Stopping Compose
does not automatically stop dynamically created application containers. Preserve
user Volumes and avoid global Docker prune. Use authenticated management operations
and confirm resource ownership for application lifecycle changes.
