# OpenApp Portal Architecture

OpenApp is a product-neutral, multi-tenant control plane for isolated Web or
single-process applications. The Portal authenticates a principal, owns the
user-to-Workspace record, provisions one isolated Environment, and proxies only
that user's traffic to it. Application-specific behavior is supplied by external adapters.

The target multi-provider Workspace, execution-control, storage and
WorkspaceGateway architecture is documented separately in
[`workspace-execution-gateway-architecture.md`](workspace-execution-gateway-architecture.md).
This document describes the behavior implemented by the current codebase.

## Repository boundary

For an independent integration repository, follow the [Adapter development guide](adapter-development.md), then [compile a composition](composition-release.md) and [deploy the resulting package](plugin-catalog-release.md). Application-specific setup and migration instructions belong in that Adapter's documentation.

```text
Core                         Platform, contracts and deployment templates
Adapter                      Application integration and compatibility
Application                  Business source and versioned release artifacts
```

The generic production graph loads an approved Adapter through
`@openapp/contracts`; it does not import either sibling repository or compile
an App's business UI into the Portal. A legacy composition loads its product
compatibility implementation from the external Adapter. Core owns only the
neutral hosts and validated interfaces; it has no built-in product fallback.

Adapter static assets follow the same boundary. They remain in the Adapter's
`assets/` directory and are published under the namespaced
`/adapter-assets/<adapter-id>/` path. The bundle exporter validates the asset
contract and copies only production JavaScript/JSON from Adapter `dist/`;
tests, declarations, source maps, links and special files are excluded or
rejected. Any legacy asset aliases must be declared by the Adapter.

### Migration boundary

Adapters own application-specific migration descriptors and compatibility implementations. Core validates the descriptor through public contracts and delegates idempotent persistence initialization to its Persistence port. A descriptor contains schema identities and preserved resources, never executable SQL or shell commands.

A recoverable release includes a database backup, matching App Revision and BuildPackage artifacts, user Volumes and a composition lock. PostgreSQL restoration alone does not demonstrate business recovery. Test a copied database and copied Volumes with a separate runtime before switching production. Rollback requires a matched release and an explicit plan for writes made after the backup.

## Request flow

```text
Browser
  -> PortalAuth
  -> AppAuthHandoffCoordinator
       -> code-owned AppAuthHandoffRegistry + catalog-resolved no-auth adapter
       -> app-specific AppAuthHandoff adapter
  -> HTTP route adapter
  -> InstanceLifecycle / ForwardingPolicyManager / AppCatalog
  -> PortalStores interfaces
  -> PostgreSQL adapter

InstanceLifecycle
  -> ContainerRuntime interface
  -> Docker CLI adapter
  -> per-instance Network + Volume + App Environment
```

An App Environment does not know about Portal users, PostgreSQL, other
Workspaces, or routing. The Portal is the only module that maps an authenticated
principal to a Workspace and its Environment. Every application runtime follows the same rule.

## Backend modules

| Module | Interface responsibility | Implementation hidden behind it |
| --- | --- | --- |
| `PortalAuth` | local password login, external account login, Portal session and admin guard | scrypt credentials, registered Provider errors, token hashing, Cookie/Bearer parsing |
| `AppAuthHandoffCoordinator` | convert an authenticated provider grant into App login/logout and proxy behavior | App lookup, adapter selection, credential cleanup and fail-closed errors |
| `AppAuthHandoffRegistry` | resolve code-owned credentialed adapters | immutable App-specific adapters; durable `none` rows are resolved by the coordinator, not inserted into this registry |
| `AppAuthHandoff` adapter | provide `onLogin`, `onLogout` and `proxyOptions` for one App | App-specific Cookie issuance, revocation and proxy policy |
| `InstanceLifecycle` | provision, start, stop, remove, idle sweep | capacity locks, per-user serialization, state reconciliation |
| `InstanceRuntimeCoordinator` (`InstanceAccessCoordinator` compatibility alias) | acquire a ready proxy target for enter, HTTP and WebSocket access | read-only observation, wake policy, stop-reason enforcement, wake single-flight and health deadline |
| `UpgradeRolloutService` | create/query durable upgrade batches and apply item-level admin commands | fixed target snapshots, idempotency fingerprints and public state-machine rules |
| `UpgradeRolloutStore` / `UpgradeRolloutWorker` | persist rollout state and advance due items independently | CAS transitions, failure budgets, worker/instance leases and restart recovery |
| `InstanceActivityTracker` / `InstanceUpgradeActivityPolicy` / `InstanceUpgradeAdmission` | observe proxy/runtime activity and atomically fence an admitted replacement | HTTP/SSE/WS leases, quiet-window samples and drain ownership; no rollout decisions in the proxy |
| `ForwardingPolicyManager` | read/update forwarding policy and check Origins | defaults, validation, persistence cache, wildcard matching |
| `ReleaseInspection` | validate one strategy package or a selected package set | dispatch to the registered Adapter inspector; package structure and application metadata rules belong to that Adapter |
| `AppCatalog` | manage App definitions, internal Revisions, package snapshots and current-image binding | PostgreSQL catalog rows, monotonic per-App revision numbers, release roots, manifest/hash checks and optimistic activation |
| `AppImageUpdateCoordinator` | inherit current packages, build and smoke-test a candidate, then bind it explicitly | package selection, Revision creation, Image Build orchestration and expected-Revision conflict checks |
| `ImageBuildManager` | durable strategy definitions, build transitions and image artifacts | strategy snapshots, optimistic state transitions, immutable digest records |
| `ImageBuildExecutor` | run one queued build through a code-owned strategy adapter | operation progress, package snapshot verification, runtime contract validation and failure cleanup |
| `BuildStrategyAdapter` | inspect strategy-defined package slots and turn them into a validated image | Adapter-owned slot/profile inspection; product-specific inspection remains external |
| `PortalStores` | identity, instance, and admin persistence interfaces | adapter projection over the selected persistence implementation |
| `MemoryPersistence` / `PostgresPersistence` | complete persistence contract | local maps or PostgreSQL queries, locks and migrations |
| `ContainerRuntime` | lifecycle of an opaque App Environment | Docker/OrbStack commands, labels, networks, volumes and limits |
| `portal-context` | composition root | concrete adapter selection and dependency wiring |
| `http-response` | HTTP request/response mapping | JSON size limits and stable HTTP errors |

`server-generic.ts` is the production executable entrypoint. It maps URLs to the
modules above and must not duplicate their authentication, lifecycle, forwarding,
or release rules. `server.ts` remains a compatibility-only facade that dynamically
delegates to `server-compat.ts` when an old composition explicitly selects it.
Importing either module does not bind a port; `startPortal()` performs
initialization and listening only when it is the executable entrypoint.

## Durable instance task batches

An administrator upgrading or rebuilding multiple existing instances does not hold one HTTP
request open while every instance becomes safe to restart. The controller
creates a durable task batch, returns `202`, and wakes a background worker. Each
instance then advances independently, so a busy instance does not delay an idle
or stopped instance from reaching the target Revision. A user may also create
the internal `instance_recovery` batch for their own `failed` instance through
the guarded start/enter exception; that path uses the same durable worker and
maintenance leases without exposing batch controls or diagnostics to the user.

The rollout path preserves the backend layering boundary:

```text
Admin HTTP controller (`portal-app`)
  -> `UpgradeRolloutService`
       -> `UpgradeRolloutSource` for Containers, launch targets and policy
       -> `UpgradeRolloutStore`
            -> `PortalStores.upgrades`
                 -> MemoryPersistence or PostgreSQL

`UpgradeRolloutWorker`
  -> `UpgradeRolloutStore` for due work and CAS transitions
  -> `InstanceUpgradeActivityPolicy` for the quiet-window decision
  -> `InstanceUpgradeAdmission` for the atomic drain gate
  -> `UpgradeExecutor`
       -> `InstanceLifecycle.rebuild`
            -> `ContainerRuntime.rebuild`
                 -> Docker CLI replacement transaction
```

The controller owns administrator authorization, JSON/HTTP mapping, auditing
and the public DTO projection. `UpgradeRolloutService` validates one to 10,000
unique instance IDs, resolves the current launch target for image upgrades, and
stores a frozen target for every item: App Revision, Image Artifact, immutable
image reference, runtime contract and launch profile. The task kind distinguishes
image upgrade, same-image rebuild, resource-policy rebuild and instance recovery;
the latter two do not supersede older image deployments, while recovery pins the
instance's current immutable image. A later App bind therefore does not
change an already-created task batch. The initial source snapshot and desired
running/stopped state are intentionally not frozen: immediately before an
execution attempt, under the per-instance maintenance lease, the worker copies
the current Container's catalog snapshot and latest running intent into the
item. A manual stop while an item is waiting therefore cannot be undone by an
old batch snapshot, while the upgrade target remains immutable. An optional
`Idempotency-Key` is scoped to the administrator and checked against a
fingerprint of the sorted instance IDs and upgrade mode. The public projection
deliberately omits the key, fingerprint, launch profile, target artifact, image
reference and runtime contract.

`UpgradeRolloutStore` is the only persistence dependency of the service and
worker. PostgreSQL stores the batch in `upgrade_rollouts`, the per-instance
state in `upgrade_rollout_items`, proxy activity in
`instance_activity_leases`, and the drain gate in `instance_upgrade_drains`.
Both persistence adapters implement revision-based compare-and-save. The
PostgreSQL idempotency and due-work indexes make replay protection and worker
resumption database properties rather than process-local assumptions. Multiple
rollout items may reference the same instance. The per-instance maintenance
lease still serializes Docker work, while due-work ordering prefers a newer
queued item over an older `awaiting_first_start` observation. A deployment
checkpoint atomically marks an older deferred item `superseded`; it is terminal
for that historical batch but is never counted as a health-verified success. Before
any newer rebuild task replaces a stopped deferred candidate, Runtime accepts that
candidate as the current baseline and deletes its older predecessor. The new
candidate therefore points to the latest deployed version, and a failed
replacement can roll back only to that version.

The worker runs under the global `upgrade-rollout-worker` maintenance lease and
uses a separate `upgrade-instance:<instance-id>` lease around each item. Its
normal item path is:

```text
queued -> assessing -> waiting_for_idle -> assessing
                    \-> draining -> rebuilding -> verifying -> succeeded (running)
                                                     \-> awaiting_first_start
                    \-> superseded (when a newer deployment reaches a safe checkpoint)
                    \-> queued (retry with backoff)
                    \-> needs_attention / cancelled
```

`waiting_for_idle` and `awaiting_first_start` do not consume `attemptCount`.
`awaiting_first_start` is a soft queue barrier: a newer item may execute while it
is pending. When that newer item reaches a safe deployment checkpoint, the older
item becomes `superseded` and the older batch can reach 100% without claiming a
health check that never happened. Only an actual rebuild, verification or
deferred-start failure consumes the default 120-failure budget; retries back off
exponentially to five minutes. Exhausting that budget produces `failed`, while permanent
missing-container, unready-target or contradictory transaction evidence
produces `needs_attention` immediately. A legacy `image_upgrade` item whose exact
target is still present but whose first-start transaction proof was lost is the
one compatibility exception: it returns to `awaiting_first_start` and waits for
the next healthy start without rebuilding. Manual continue/force resets the budget.
Verification always compares the persisted App Revision, Image Artifact when
available and immutable image reference. A running target must also be running;
a rebuilt stopped target instead remains pending until Runtime proves that its
deferred first healthy start committed. Matching the tag alone is not proof of
success.

`InstanceActivityTracker` is coupled only to the HTTP and WebSocket proxy
boundaries. It records connection heartbeats and byte activity without knowing
about rollout state. For a running instance, `InstanceUpgradeActivityPolicy`
rejects an active HTTP/SSE lease or recently active WebSocket, then requires two
runtime samples across a full 60-second quiet window with unchanged network
counters and CPU at or below five percent. Lease heartbeats older than 45
seconds are ignored so an unclean Portal exit cannot block an instance forever.

After the policy reports idle, `InstanceUpgradeAdmission` performs the final
activity check and creates the drain record atomically. While the drain is
valid, new proxy leases and ordinary start, stop, remove or rebuild operations
fail instead of racing the replacement. Quiet WebSockets owned by the current
Portal are closed only after the gate is held. The drain is cleared in the
worker's `finally` path and also has a two-hour expiry as crash protection.

Docker rebuild is a staged replacement transaction over the existing Volume:

1. Validate the managed Volume and networks, then create an unstarted candidate
   named `<canonical>-rebuild-next` with ownership, predecessor and recovery
   labels.
2. Stop a running predecessor with Docker's 30-second grace period, rename it
   to `<canonical>-rebuild-previous`, and rename the candidate to the canonical
   name.
3. For a desired running instance, start the candidate and make the loaded
   Adapter `RuntimeProfile.healthPath` (default `/api/health`) the commit
   probe. Remove the predecessor only after that probe succeeds.
4. On any pre-commit failure, remove the candidate, restore the predecessor's
   canonical name and restart it when it was previously running.

A desired stopped instance is replaced without being started; its predecessor
is retained until the first later start passes the same health probe, providing
the rollback point for that deferred commit. The item remains
`awaiting_first_start`, counts as waiting in the parent rollout, and cannot be
declared successful merely because the stopped candidate exists. The later
`ContainerRuntime.start` health-checks the candidate before removing the
predecessor; an unhealthy candidate is fenced, the predecessor and its catalog
snapshot are restored, and the rollout can retry.

When a newer image, same-image, or resource-policy rebuild task arrives first, the worker explicitly asks Runtime to
accept the stopped deferred candidate as the next baseline. Runtime validates
the owner, transaction and predecessor labels, refuses ambiguous side artifacts,
then removes the older predecessor before staging the new candidate. This
acceptance is idempotent across Portal interruption and never removes the shared
Volume. Lifecycle operations outside a task batch retain the conservative
rollback behavior; user recovery is deliberately a task-batch operation and
therefore participates in the same latest-baseline acceptance rules.

Every worker attempt ID is also the Runtime rebuild transaction ID. The
read-only `ContainerRuntime.inspectRebuildTransaction` classifies labeled
artifacts as `pending`, `committed`, `not_found` or `inconsistent`. The worker
uses that proof together with the persisted source/target snapshots:
`committed` remains success even if the user stopped the target again;
`not_found` alone is never success for same-image, resource-policy, or recovery
tasks. For the legacy image-upgrade compatibility exception, `not_found` plus an
exact stopped target means “proof missing, await first start”, not success;
conflicting relationships require operator attention. Runtime `get`/lifecycle sync also reconciles leftover
`-rebuild-next`, `-rebuild-previous` and rollback tombstones using ownership,
transaction and predecessor labels before the control-plane snapshot is
updated. Only after the Runtime transaction succeeds does `InstanceLifecycle`
persist the new version/image snapshot; the worker then performs its independent
durable verification.

The Portal wakes the worker after rollout creation, after a manual resume, at
startup, and on the 30-second maintenance interval. In-progress items left in
`assessing` or `draining` for ten minutes are moved back to `queued` with
`portal_restarted`. An interrupted `rebuilding` or `verifying` item with an
attempt ID, regardless of its running/stopped intent, keeps that ID and moves to
`awaiting_first_start` with `candidate_recovery_pending`. Recovery must inspect
and reconcile that Runtime transaction before it can complete, retry or require
operator attention; it never allocates a fresh attempt and repeats rebuild
first. Items without transaction evidence return to `queued`. CAS revisions
prevent an older worker from overwriting the recovered item. The global and
per-instance leases allow multiple Portal processes to share the same
PostgreSQL state without executing the same replacement concurrently.

The Portal application layer serializes rollout wake-ups and the idle-stop sweep
through one in-process maintenance coordinator. Rollout work always runs before
the sweep because both paths use the same per-instance maintenance lease; starting
them concurrently on the same 30-second phase would let the sweep repeatedly win
the non-blocking lease and starve an overdue rollout. Wake-ups received while a
worker or sweep is active are coalesced into a later worker pass before the next
sweep. PostgreSQL advisory leases remain the cross-process ownership boundary;
the coordinator supplies only local ordering and does not move rollout decisions
into the HTTP controller or lifecycle domain.

The PostgreSQL maintenance lease supplies an `AbortSignal` that aborts when its
advisory-lock connection fails or ends. Portal operation boundaries combine it
with any caller signal and propagate it through lifecycle sync/start/stop/
rebuild/remove, Runtime transaction inspection, and each Docker CLI command.
Losing the lease therefore terminates the in-flight command and fences later
Docker side effects or catalog persistence; a later owner resumes through the
same transaction reconciliation path.

## App and image ownership

The catalog owns stable App identity, internal Revisions and the current-image
binding. The build domain owns reusable package bytes, strategy execution and
immutable image artifacts:

```text
App (apps)
  -> one current App Revision selected by status
BuildPackage (build_packages + releases/build-packages/<package-id>/)
  -> one reusable strategy slot + immutable hash + slot-local source metadata
App Revision (app_versions, compatibility table name)
  -> inherited package IDs with selected slots replaced
  -> ImageBuild (image_builds, frozen strategy/package snapshot)
       -> runtime smoke validation
       -> ImageArtifact candidate (image_artifacts, immutable `sha256:<image-id>`)
  -> explicit expected-Revision binding makes the candidate current
Container
  -> App Revision + Image Artifact + immutable image ID snapshots
```

`BuildPackageStorage` streams uploads into build-owned durable storage, persists
only a release-root-relative key, and verifies size plus SHA-256 whenever a package
is selected again. Each registered strategy revision defines its own package slots and validation rules. Durable builds resolve the exact pinned strategy revision.

`AppImageUpdateCoordinator` starts from the current Revision, inherits omitted
slots and replaces only the package IDs supplied by the administrator. It creates
a new immutable Revision and Image Build. `ImageBuildExecutor` resolves the exact
adapter revision frozen by that build, runs the code-owned builder, validates the
runtime startup contract and records an Image Artifact only after smoke validation.
A failed build leaves the current App and every instance unchanged.

The resulting Revision is an `image_ready` candidate. Binding is a separate action
that includes the expected current Revision; PostgreSQL activation is conditional,
so two administrators cannot silently overwrite each other. New instances use the
new current image. Existing instances retain `app_version_id`, `image_artifact_id`
and immutable `image_reference` until an administrator explicitly upgrades them;
upgrade rebuilds the container while preserving its Volume.

Cleanup is reference-safe. Preview applies the requested rollback-retention count
and reports candidates plus blockers. Retention is never lower than one previous
Revision per App when a rollback candidate exists. A cleanup run skips every
Revision referenced by a Container, including stopped instances. It also treats
both the latest rollback source and the fixed target of every rollout item not in
`succeeded` or `cancelled` as live references. This includes `failed` and
`needs_attention` items because an administrator can retry them. Source and target
Revision, Artifact and immutable image-reference matches therefore block archival
or deletion until the rollout no longer owns them.

Cleanup archives only older unreferenced Revisions, retains their package hashes,
sizes and completed Image Build audit snapshots, and releases their
package/artifact identifiers. A Build Package cannot be deleted while any
remaining Revision or Image Build snapshot names its package ID. An Image Artifact
cannot be deleted while any Revision, Container or protected rollout source/target
names its artifact identity. Preview, prune and conditional deletes all recheck
those references; the database deletion is atomic, and the runtime image is
removed only for the resolved image ID being released. Callers never infer safety
from an earlier preview. Operators must still include `releases/build-packages/`
in backups and capacity planning.

The `AppVersion` type, `app_versions` table and `/versions` endpoints remain as
compatibility surfaces for legacy releases. The normal user-facing workflow does
not ask an administrator to coordinate semantic App versions or package build IDs.

The ordinary-user `/api/apps` projection contains only Apps with a current launchable Revision
and no archive paths or checksums. Administrator routes and `openappctl apps ...`
own catalog mutations. Credential behavior is still code-owned: an App may use a
registered handoff adapter, or the explicit credential-free `none` adapter; a
database row cannot invent a Cookie or token forwarding rule.

Local credentials, external identities and Portal Sessions are separate
records. External users are resolved by provider plus immutable subject, not
by browser-supplied user IDs. Management authorization comes from the persisted
`admin` or `super_admin` role. Both roles may use local credentials or a linked
external identity and operate the management workbench. Administrators may
create members, but all role values are read-only to them. Only a super
administrator can create management accounts or change another account's role;
the actor is reauthorized, the target's expected role is checked, and the
change plus audit event commit atomically. A super administrator cannot change
its own role, concurrent changes cannot remove every super administrator, and
the CLI management token never carries super-administrator authority. External
login and registration create ordinary members only. Ordinary role changes are
visible through an existing Session on its next request because authorization
reloads the persisted user. If a promotion also creates missing local
credentials, that account's existing Sessions are revoked in the same
transaction.

## Application authentication handoff

Portal identity and downstream App identity are deliberately separate. An
authentication provider proves who the user is and may return short-lived
credential material. It does not know which App will consume that material.
`AppAuthHandoffCoordinator` owns the single seam between a successful Portal
login and an App-specific session:

```text
Auth provider
  -> verified external identity + credential grant
  -> PortalAuth creates the Portal Session
  -> AppAuthHandoffCoordinator
       -> AppAuthHandoffRegistry[instance.appId] (or the unique grant consumer on first login)
       -> AppAuthHandoff adapter
            onLogin: issue the App's browser session material
            onLogout: clear and, when supported, revoke it
            proxyOptions: declare the App's forwarding policy
```

Credentialed adapters are static, code-owned registrations assembled in
`portal-context` at process start. Credential-free `none` behavior is resolved
from the durable App catalog on each login/proxy boundary, so a newly-created
App is visible to every Portal process without a restart; it never accepts or
forwards a provider grant. The App ID used for an existing instance comes from
the authenticated user's persisted record. Before the first instance exists, a
submitted `appId` must match an active catalog entry and its server-registered
adapter (or the explicit catalog `none` mode); it cannot declare a new adapter
or forwarding rule. Registry keys are normalized App IDs; credentialed
registrations are supplied by external Adapters. An explicit catalog `none` App
is valid without a credential adapter; unknown IDs and rows claiming a
credentialed adapter without a static registration fail closed with
`app_auth_handoff_not_registered`, preventing the request from reaching an
instance. Logout uses the coordinator's all-adapter cleanup so stale cookies
are cleared even when the user's instance record is gone.

A registered handoff accepts only its own credential grant, issues and clears application cookies, and declares forwarding policy. PortalAuth does not interpret provider tokens or application cookie names.

When an external login returns a credential grant, the coordinator selects the
single registered adapter that declares that grant type. If the user already
owns a credentialed App instance, a different consumer is rejected and the
fresh provider grant is revoked; a no-auth instance may retain the provider
session for a later credentialed App selection.

The interface, registry and coordinator live in
`backend/src/auth/app-auth-handoff.ts`. Concrete handoff implementations and their regression tests belong to external Adapters.

To add downstream single sign-on for another App:

1. Implement one `AppAuthHandoff` adapter for that App's explicit credential
   and session contract.
2. Return the handoff from the external Adapter factory and select that Adapter
   in the deployment catalog. The Core composition root registers it; do not edit
   `portal-context`, Portal routes, `PortalAuth`, or the generic proxy for an App.
3. Add contract tests for login, logout, credential replacement and proxy
   behavior, including a negative test proving that Portal and other App
   credentials are not forwarded.
4. Register the real App only after those contract tests pass. Until then the
   unregistered, fail-closed behavior remains in effect.

Every handoff adapter must preserve these security invariants:

- Credential material never enters JSON responses, PostgreSQL, localStorage,
  IndexedDB, URLs, logs, runtime labels or instance environment variables.
- The Portal Session, administrator bearer token and credentials belonging to
  another App are stripped before a request reaches a user instance.
- Cookie names are fixed in reviewed adapter code. Database values
  cannot define arbitrary credential forwarding rules.
- App selection is validated against the server-owned catalog and instance
  record; ownership is authorized before adapter lookup or proxying.
- Unsupported grant kinds, missing adapters and adapter mismatches fail
  closed with an explicit error; they never fall back to proxying or forwarding
  the incoming credential.
- Browser cookies are host-only, receive the required `HttpOnly`, `Secure` and
  `SameSite` attributes, and use root scope only when the App contract requires
  it. New Apps default to an isolated cookie namespace or instance path.
- Refresh credentials are revoked when replaced or logged out when the
  provider supports revocation. A refresh session is not shared across Apps
  unless an adapter explicitly declares and tests that policy.
- All Apps currently share the Portal origin under `/instances/<id>/`. The App
  catalog is therefore a trusted-package boundary: only administrator-reviewed
  images and Web archives may be activated. An untrusted App requires a
  separate origin or subdomain because same-origin browser code can otherwise
  call Portal routes and observe host-scoped cookies; isolated-origin Apps are
  intentionally outside the current catalog contract.

## Runtime isolation invariants

For instance `I` owned by user `U`, the selected Runtime profile creates one container, one
private network, one isolated egress network, and one volume. Every resource
carries all three labels:

```text
<profile.labelPrefix>.managed=true
<profile.labelPrefix>.instance-id=I
<profile.labelPrefix>.owner-id=U
```

New networks also record their configured pool and allocated subnet. The selected
Runtime profile owns any provider-specific pool variables and allocation rules;
the generic Core only requires a unique network per Workspace and never infers
those variables from an App id.
Existing labeled networks remain compatible without these newer allocation
labels.

Two user containers never share a network. In container endpoint mode, the
Portal joins each instance network dynamically and reconnects after a Portal
restart. A remove operation validates all existing container, network, and
volume labels before issuing its first destructive command. A mismatched or
unmanaged resource is never adopted or deleted.

The Docker socket is an infrastructure authority and must never be mounted in
a user instance. Production deployments should expose only the required
Engine operations through a restricted socket proxy.

The Portal's PostgreSQL `control` network is internal. Its separate egress
network is needed for external authentication and registry access; user instances
never join either control-plane network.

## Frontend modules

`App.tsx` is only the authentication gate and role router. Feature state and
side effects live under `frontend/src/features/`:

- `auth`: session restoration and login flow.
- `instances`: the user's single-App lifecycle view.
- `admin`: workspace loading plus overview, users, App catalog/Revision, policy,
  runtime/release, and forwarding panels.

Frontend modules call the existing Portal request clients. They never choose a
user ID or runtime endpoint; authorization and ownership remain server-side.

## Verification seams

- `PortalAuth`, `InstanceLifecycle`, `ForwardingPolicyManager`, candidate build/current binding,
  reference-safe cleanup, proxying, and HTTP JSON parsing have contract tests at their
  public interfaces.
- The Docker adapter tests resource ownership, per-instance networks, Portal
  reconnection, deletion ordering, and loopback compatibility.
- Production verification must additionally create two real instances and
  prove that A cannot connect to B while the Portal can reach both.
