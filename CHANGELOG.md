# Changelog

## Unreleased

- Normalize generic release artifacts before fingerprinting so Docker build pruning preserves integrity on clean Linux installations; execute the pruner correctly through macOS temporary-directory aliases.
- Add English Adapter development, browser/backend references, source mapping, composition and deployment guides; replay matching bilingual tutorial commands in CI.
- Consolidate documentation around maintained guides and add the planned Kubernetes/runtime extension direction to both project READMEs.

- Reject untrusted browser mutations and non-JSON API bodies; preserve authorized CLI access.
- Correct direct-hosted module MIME/cache behavior and redact request query/account diagnostics.
- Add persistence readiness, bounded graceful shutdown, SDK tarball installation and public browser types.
- Split PostgreSQL schema/record mapping and Docker support code from lifecycle implementations.
- Pin release base images and Actions; add draft release attestations, image scanning, contribution templates, dependency updates and quality/coverage reporting.

- Export a Core-only control plane with no Adapter or Docker socket service.
- Include one-time administrator bootstrap in composed releases; reject bootstrap when a super administrator exists.
- Load modern Adapter login views independently of legacy compatibility mode.
- Require clean Git components for `--official` exports; record versions, revisions and source digests and verify file fingerprints.
- Include npm dependency inventories and available third-party license texts in exported bundles.
- Add mandatory migration, runtime, fresh-install and source/dependency security CI jobs.
- Provide a neutral persistent HTTP sample, Node.js 24 baseline and contributor/security documentation.

## 0.1.0 baseline

The package version identifies the initial pre-1.0 Core line. This entry is not a claim that a tagged public release or production migration has been completed. Individual deployments remain identified by their release fingerprint and component revisions.
