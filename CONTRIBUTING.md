# Contributing

Use the latest Node.js 24 LTS patch (`.node-version`; at least 24.15.0 for frontend tests), npm and Docker Engine/OrbStack. Install dependencies with `npm ci` at the root, then in `backend/runtime`, `backend` and `frontend`. The contracts compiler is provided by the root lockfile.

See [local development and tests](docs/local-development.md) for runtime profiles and commands, the [support matrix](docs/support-matrix.en.md) for tested versions, or the [English documentation index](docs/README.en.md) for application integration and deployment guides.

Keep Core application-neutral. Add application identity, authentication policy, branding, build slots and legacy data projections to an independently versioned Adapter. Depend on `@openapp/contracts`; never import another repository's private source or copy its implementation into Core. See [Adapter development](docs/adapter-development.en.md).

Use small changes with an explanation of behavior, compatibility and relevant tests. Do not include `.env`, database contents, local paths, personal accounts or generated deployment folders. Test fixtures must use synthetic data. Follow the Apache-2.0 license; contributions are submitted under the same license.

Before submitting, run backend and frontend tests, frontend type checks, `npm run test:deployment`, `npm run test:profiles`, `npm run test:release`, `npm run check:docs` and `npm run test:secrets` (Gitleaks required). Run exporters and builds serially because they share `dist`. Changes to migrations, persistence or runtime behavior also require disposable PostgreSQL and Docker acceptance; do not point tests at a production database. CI runs these gates without opt-in variables.

Release changes require the clean-install test and regression against the matching Adapter versions. Document public contract changes, bump the appropriate package version and record them in [CHANGELOG.md](CHANGELOG.md). Do not claim a release is production-ready from unit tests alone; record the specific migration chain and restore/lifecycle evidence.

Run `npm run check:quality` and `npm run test:sdk` for source/SDK changes. Format changed files with Prettier; exact-hash exceptions in config/format-baseline.json apply only to untouched legacy formatting. Backend unit tests are auto-discovered, while PostgreSQL and Docker integration remain explicitly isolated. CI preserves LCOV reports for coverage comparisons. See [composition](docs/composition-release.en.md) and [governance](GOVERNANCE.md).

Changes to main normally go through a pull request with one approval and the required CI checks. Repository administrators may bypass these branch rules and push directly; they remain responsible for running relevant tests. Use your GitHub noreply address in repository-local Git configuration if you do not want a personal email published in commits.
