# UI and logic ownership map

[Development guide](adapter-development.en.md) · [简体中文](adapter-source-map.md)

Core paths below help locate behavior; they are **not** public Adapter imports.
Adapter filenames are suggested organization, not mandatory names. Public entry
points are the factory, manifest and package.json declarations.

| Surface                            | Core implementation                                                                                                                               | Adapter responsibility                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| No-Adapter home                    | [UnavailableEntryPage](../frontend/src/features/entry/UnavailableEntryPage.tsx)                                                                   | None                                                         |
| User entry/session/workspace flow  | [WorkspaceEntryPage](../frontend/src/features/entry/WorkspaceEntryPage.tsx), [user-entry-flow](../frontend/src/features/entry/user-entry-flow.ts) | Entry, Provider and challenge declarations                   |
| Application login                  | [WorkspaceLoginPage](../frontend/src/features/auth/WorkspaceLoginPage.tsx)                                                                        | assets/auth-ui.mjs → views.workspace                         |
| Admin login                        | [LoginPage](../frontend/src/features/auth/LoginPage.tsx)                                                                                          | views.control supplies the application SSO button/panel only |
| Platform branding/local admin form | [LoginPage](../frontend/src/features/auth/LoginPage.tsx)                                                                                          | No override                                                  |
| App catalog/build slots/Revision   | [AppsPanel](../frontend/src/features/admin/AppsPanel.tsx), [app-build-state](../frontend/src/features/admin/app-build-state.ts)                   | manifest.build describes slots; backend strategy executes    |
| Instance management                | [ResourcesPanel](../frontend/src/features/admin/ResourcesPanel.tsx)                                                                               | Runtime/health/storage contract, not a replacement page      |
| Business UI                        | [proxy](../backend/src/proxy.ts) forwards to the instance                                                                                         | Maintained in application repository/image                   |

Only the two login views are executable browser extension points. Labels and build
slots are declarative data, not arbitrary HTML/JS injection. For no external
Provider and `entry.challenge=none`, Core's [local workspace form](../frontend/src/features/auth/LocalWorkspaceLoginPage.tsx)
handles login/registration. A missing authProviderId alone does not mean the App is unavailable.

| Logic                    | Adapter entry                                     | Core host                                                                                                                                                            |
| ------------------------ | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Factory/version/registry | src/index.ts                                      | [external-adapter](../backend/src/external-adapter.ts), [adapter-catalog](../backend/src/adapter-catalog.ts), [platform-plugins](../backend/src/platform-plugins.ts) |
| External identity        | authProvider                                      | [provider-registry](../backend/src/auth/provider-registry.ts), [portal-app](../backend/src/portal-app.ts)                                                            |
| Accounts/roles/sessions  | No role grant or Core database access             | [portal-auth](../backend/src/auth/portal-auth.ts), [user-role-policy](../backend/src/user-role-policy.ts)                                                            |
| Cookies and credentials  | authHandoff                                       | [app-auth-handoff](../backend/src/auth/app-auth-handoff.ts), [proxy](../backend/src/proxy.ts)                                                                        |
| Browser loading          | package.json openapp.authUi                       | [auth-ui](../frontend/src/features/auth/auth-ui.ts)                                                                                                                  |
| Package parsing/building | buildStrategy, releaseInspector, deployment/build | [image-builds](../backend/src/image-builds.ts), [app-image-updates](../backend/src/app-image-updates.ts)                                                             |
| Runtime execution        | manifest.workload.runtime                         | [runtime-contracts](../backend/src/runtime-contracts.ts), [docker-cli-runtime](../backend/runtime/src/docker-cli-runtime.ts)                                         |
| Ownership/scheduling     | No private host access                            | [workspace-authorization](../backend/src/workspace-authorization.ts), [workspace-execution-manager](../backend/src/workspace-execution-manager.ts)                   |
| Historical projections   | Optional compatibility/legacy                     | [legacy-host](../backend/src/legacy-host.ts), [postgres](../backend/src/persistence/postgres.ts)                                                                     |
| Composition              | Adapter build script and catalog                  | [export-openapp](../scripts/export-openapp.mjs)                                                                                                                      |

The database stores app names, strategy/slot snapshots, versions, artifacts and
instance state. It does not contain loadable Adapter JavaScript. Historical names
may remain visible after removing a plugin, but execution depends on loaded
capabilities and `executable`/`unavailableReason`. Do not delete user data simply
to hide a historical label.

| Change                           | Delivery                                                                                  |
| -------------------------------- | ----------------------------------------------------------------------------------------- |
| Login UI/CSS/icons               | Recompose and deploy the frontend image                                                   |
| Provider/handoff/build strategy  | Recompose and deploy matching backend; frontend too if entry/assets change                |
| Runtime profile/startup contract | Build matching business image, validate/activate Revision and update Adapter as needed    |
| Public Core/contracts interface  | Test affected Adapters and recompose; do not replace a plugin in an incompatible old host |
| Ordinary business UI feature     | Release the application's image independently                                             |

See [browser](adapter-ui.en.md), [backend](adapter-backend.en.md) and
[composition](composition-release.en.md) references.
