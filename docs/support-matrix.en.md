# Support matrix

This matrix describes the tested public baseline. An Adapter or application may
impose stricter requirements; record the exact Core, contracts and Adapter
versions used for every composed release.

| Area               | Supported baseline                                            | Boundary                                                                                                                     |
| ------------------ | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Core               | 0.1.x development line                                        | Public contracts are versioned independently from implementation files.                                                      |
| Contracts SDK      | 0.2.x                                                         | Adapters should declare the tested Core/contracts range in their manifest.                                                   |
| Node.js            | 24 LTS (24.15.0 or newer)                                     | Used by local development and CI; frontend test dependencies require at least 24.15.0. Other release lines are not the tested baseline. |
| PostgreSQL         | 17                                                            | Migrations are tested on disposable PostgreSQL 17; production backups and restore drills remain deployment responsibilities. |
| Execution runtime  | Docker Engine and OrbStack                                    | Provider and runtime access is privileged; do not expose the Docker control endpoint publicly.                               |
| Workspace shape    | One application container and one HTTP entry per workspace    | Arbitrary multi-container application stacks are outside the current contract.                                               |
| Persistence        | PostgreSQL control data plus per-workspace persistent storage | External databases and object stores require application-specific tenant isolation.                                          |
| Browser extensions | Same-origin Adapter modules loaded by the trusted Portal      | Adapter code is not a sandbox and must be reviewed before composition.                                                       |
| Future providers   | Kubernetes and additional runtimes are planned                | They are not available in the current release line.                                                                          |

## Compatibility policy

Patch releases preserve the documented public contracts whenever practical.
Breaking contract changes before 1.0 require a new minor version and a migration
note. A deployment fingerprint identifies the exact source and generated files;
the version number alone is not a complete release identity.

For support requests include the fingerprint, Core/contracts/Adapter versions,
runtime, PostgreSQL version, deployment mode and a sanitized reproduction. Follow
the [support policy](../SUPPORT.md) and [security policy](../SECURITY.md).
