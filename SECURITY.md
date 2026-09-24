# Security policy

Security fixes target the latest supported release. The current pre-1.0 line is 0.1.x; older snapshots have no maintenance guarantee. Node.js 24 LTS is the tested baseline.

Report vulnerabilities through the repository's **Security → Report a vulnerability** private reporting channel, enabled for this repository. Do not put credentials, database dumps, user files, exploit tokens or private hostnames in public issues. If private reporting is unavailable in a fork, request a private reporting channel without posting exploit details.

Include the release fingerprint, component versions, affected endpoint, minimal reproduction using synthetic accounts, impact and any mitigation. Reports are investigated on a best-effort basis; no response-time SLA is promised.

Adapters execute trusted code inside the backend process and may supply browser modules. The plugin boundary is an API contract, not a sandbox. Review their code and dependencies before composition. Runtime applications use separate containers and storage; Docker control access is privileged and must not be publicly exposed.

Official bundles require clean component checkouts and contain source revisions, content digests and file checksums. Checksums detect corruption but are not signatures: obtain the bundle and fingerprint through a trusted channel. Use TLS, unique administrator credentials, restricted management access and tested database/Volume backups.

CI scans the current publishable file set with Gitleaks and audits npm dependencies. Ignored development data is not part of that set. Never publish an archive of the whole working directory; use a clean Git checkout or the release exporter. Git history review is a separate publishing responsibility.
