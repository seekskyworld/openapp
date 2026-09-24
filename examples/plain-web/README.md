# Plain Web runnable example

This neutral Adapter registers an HTTP application with a persistent per-workspace counter. It has no external identity provider, application cookies or Core private imports. `plugin.mjs` remains a minimal contract fixture; `index.mjs` is the runnable factory.

After installing the root/backend/frontend dependencies, run from Core:

```sh
npm --prefix examples/plain-web run build
docker build -t plain-web:1.0.0 examples/plain-web/runtime
npm run release:openapp -- examples/plain-web/openapp.release.json /tmp/plain-web-release
```

Follow [first installation](../../docs/first-install.md), retaining the exported Adapter settings (not control-plane-only). Build the two control-plane images, start PostgreSQL, docker-socket-proxy, portal-backend and frontend, then bootstrap an administrator. Use a separate Compose project and data directory. The manifest seeds the plain-web:1.0.0 revision; this image must exist in the Docker daemon managed by Core. Sign in locally at `/control`, select Plain Web and create/start a workspace. Increment its counter, restart the instance and confirm that the value persists.

The application runs as `node`, listens on 8080, exposes `/health` and stores data under `/data`. There are no upload/build slots; update images using the generic image-import workflow. Keep the unauthenticated application port behind Core's proxy, not publicly exposed.

The exported OPENAPP_RELEASE_PATH is plain-web. Create `<OPENAPP_DATA_ROOT>/plain-web` owned by UID/GID 10001 before starting the composed backend; the Core-only guide's openapp subdirectory is not used for this example.

Run real storage/lifecycle acceptance with the same profile:

```sh
OPENAPP_RUNTIME_ACCEPTANCE_IMAGE=plain-web:1.0.0 \
OPENAPP_RUNTIME_ACCEPTANCE_PROFILE="$PWD/examples/plain-web/runtime/profile.json" \
npm run test:acceptance -- --docker
```

Tests create uniquely named disposable resources and verify isolation, restart, rebuild and storage deletion. They do not attach real user Volumes. The example is included for learning; an official composed release requires an independent clean Adapter Git repository. See [contracts](../../packages/contracts/README.md) and [composition](../../docs/composition-release.md).
