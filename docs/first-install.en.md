# First installation: Core only

These commands are for a **fresh Core-only installation**. Existing deployments
must retain their database, Volumes, project identity and configuration. For an
application-enabled composition, use `docs/plugin-catalog-release.en.md`
in the source repository, or the generated bundle's README.md. Do not export an empty
catalog when you intended to include an Adapter.

Use Node.js 24 LTS, npm, Docker Engine/OrbStack and Compose v2. From a source checkout:

```sh
npm ci
npm --prefix backend/runtime ci
npm --prefix backend ci
npm --prefix frontend ci
npm run release:openapp -- config/core.release.json /tmp/openapp-core-release
```

If you already received a verified Core-only bundle, skip export and enter that
directory. For the example above:

```sh
cd /tmp/openapp-core-release
node verify.mjs
bash build-images.sh
cp core/.env.example core/.env
chmod 600 core/.env
```

Set BACKEND_IMAGE/FRONTEND_IMAGE to the printed fingerprinted image names. Choose
a unique COMPOSE_PROJECT_NAME and absolute OPENAPP_DATA_ROOT. Generate independent
POSTGRES_PASSWORD and OPENAPP_ADMIN_CLI_TOKEN values (e.g. `openssl rand -hex 32`).
Configure actual origins and PORTAL_PORT/PORTAL_BACKEND_PORT. Keep
OPENAPP_CONTROL_PLANE_ONLY=true and OPENAPP_ADAPTER_REQUIRED=false.

For a **new** data root, with OPENAPP_RELEASE_PATH=openapp:

```sh
sudo install -d /srv/openapp-data/postgres/data /srv/openapp-data/postgres/init /srv/openapp-data/frontend/nginx/logs
sudo install -d -o 10001 -g 10001 /srv/openapp-data/openapp
cd core
docker compose --env-file .env up -d --no-build --wait postgres portal-backend frontend
bash bootstrap-admin.sh
```

Set OPENAPP_DATA_ROOT=/srv/openapp-data in this example. If the artifact subdirectory
differs, create the directory selected by OPENAPP_RELEASE_PATH with UID/GID 10001.
Bootstrap privately asks for email/password and refuses if a super administrator
already exists. It does not reset accounts. Backend startup initializes the schema.

Default local management URL is `http://127.0.0.1:14310/control`. Core-only home
explains that no Adapter is configured; no business lifecycle or Socket Proxy is
available. For public access configure domain, TLS, gateway and secure Cookies;
starting these three services alone does not provide public TLS.

From source, `npm run test:clean-install` checks isolated fresh initialization,
repeat-bootstrap rejection, login/permissions, repeated migrations and restart.
It needs Docker/network access and cleans only resources it creates.
