# Container Runtime

`@openapp/container-runtime` is the infrastructure port between the OpenApp Portal
application and Docker-compatible container engines. OrbStack exposes the
Docker CLI/API, so macOS and Linux both use `DockerCliRuntime`; there is no
separate business implementation for OrbStack.

The package is workload-neutral. A deployment supplies a validated
`RuntimeProfile` from its App Adapter; the Runtime does not discover an App by
name, import a sibling repository, or silently select a product-specific image.

Set `CONTAINER_RUNTIME=docker` on Linux or `CONTAINER_RUNTIME=orbstack` on
macOS for deployment metadata; both values deliberately select the same
Docker-compatible provider. The standard `DOCKER_CONTEXT` and `DOCKER_HOST`
variables select the OrbStack/Docker Engine endpoint. `DOCKER_HOST` is consumed
by the Docker CLI itself and is never forwarded into a user container.

The caller supplies only server-issued `instanceId` and an authenticated
principal's `ownerId`. Network, volume path, port and capabilities remain
platform policy; the control plane may apply an administrator-approved image,
resource profile, environment and startup-file template to a new instance.
Browser requests must never be mapped directly to Docker arguments.

`ProvisionContainerRequest.launchProfile` is the validated policy snapshot. It
selects `imageReference`, `resources` (`memory`, `cpus`, `pidsLimit`), string
environment entries and relative config files. Runtime validation rejects
unsafe resource values, reserved Core/profile environment keys, absolute or
traversing config paths and duplicate paths.

Core passes declared config files through the profile's configuration environment
key. The Adapter and workload image define how to apply them, including any
initialization marker or overwrite policy. Core does not require a particular
marker filename. Changing Portal policy does not directly rewrite existing Volumes;
Adapters must test initialization and restart behavior for their own images.

Two endpoint modes are supported:

- `loopback`: for a Portal process running on the host. A random container port
  is published on `127.0.0.1` only. The instance still receives its own managed
  Docker network, but the host Portal does not join it.
- `network`: for the Compose deployment. No host port is published; the Portal
  is dynamically connected to each instance's dedicated managed network and
  proxies to the container through that network. User instances never share a
  network, so they cannot address one another directly.

`OPENAPP_NETWORK_NAME_PREFIX` controls the per-instance network name prefix.
`OPENAPP_NETWORK_POOL_CIDR` and `OPENAPP_NETWORK_SUBNET_PREFIX` control the
private IPv4 pool used for managed instance networks. The default
`10.240.0.0/12` pool is divided into `/28` networks; each instance consumes one
private and one egress subnet, for 32,768 address slots per Docker host. Network
creation uses a stable instance-derived candidate and probes the next subnet
when Docker reports an overlap with another managed bridge or address pool.
In network mode, `OPENAPP_PORTAL_CONTAINER` identifies the Portal container
that Docker must connect; the Compose deployment gives it a stable name. The
Adapter creates both Network and Volume explicitly with managed, instance and
owner labels. Existing resources are reused or removed only after all labels
match, and `get()` reconnects a restarted Portal before returning an endpoint.

## Compatibility profiles

The generic profile uses the `OPENAPP_*` namespace and neutral image, resource,
label and data-root defaults. An older deployment may pass an explicit Adapter
profile to `dockerCliRuntimeConfigFromEnv` with `compatibilityMode: true`; that
profile owns any historical namespace, startup script, lock recovery and
resource aliases. Legacy aliases are never read by the generic profile merely
because they remain in the process environment. This keeps rollback support
available without making a product implementation part of the Runtime package.

Build and test:

```bash
cd backend/runtime
npm install
npm test
```

For an actual Docker regression against a workload without Node:

```bash
# From the repository root; all created test resources are isolated and cleaned up.
docker build -f backend/runtime/src/testing/http-runtime.Dockerfile -t openapp-http-test:local backend/runtime/src/testing
npm --prefix backend/runtime run build
OPENAPP_RUNTIME_ACCEPTANCE=1 \
OPENAPP_RUNTIME_ACCEPTANCE_IMAGE=openapp-http-test:local \
OPENAPP_RUNTIME_ACCEPTANCE_PROFILE=backend/runtime/src/testing/http-runtime-profile.json \
node --test backend/runtime/dist/docker-cli-runtime.integration.test.js
```

Acceptance probes use a separate `OPENAPP_RUNTIME_PROBE_IMAGE` (default
`node:24-bookworm-slim`) for health and Volume checks. Network probes share only
the workload network namespace; they do not execute tools inside the workload.
The deployment verifier checks probe functionality before testing isolation and
fails on tool/Docker errors instead of treating them as proof of isolation.

Production image smoke validation and replacement health checks also use this
independent probe image. Pre-pull it on the Docker host before an upgrade; offline
deployments must import it or configure a trusted Node-capable mirror image
(preferably pinned by digest). Compose forwards `OPENAPP_RUNTIME_PROBE_IMAGE`.
An unavailable probe fails validation; it is never treated as a healthy workload.
Workload images do not need Node or other probe utilities installed.

Image smoke tests mount a dedicated anonymous Volume at the profile data path,
using Docker's normal image-directory copy-up to preserve ownership and initial
content. Cleanup removes that Volume with the smoke container. Applications must
prepare that directory in their image or initialize it at startup, just as for a
fresh production Volume. The non-Node fixture runs as UID 1000 and must write to
the data directory before its health endpoint starts.

When Docker's default address pools are exhausted, the deployment verifier
accepts four explicit unused CIDRs: `OPENAPP_RUNTIME_VERIFY_SUBNET_A`,
`OPENAPP_RUNTIME_VERIFY_SUBNET_B`, `OPENAPP_RUNTIME_VERIFY_EGRESS_SUBNET_A`, and
`OPENAPP_RUNTIME_VERIFY_EGRESS_SUBNET_B`. Docker rejects overlapping allocations.
Only networks created for that verifier run are removed during cleanup.
