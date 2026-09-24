# Project governance and maintenance

OpenApp currently uses a maintainer-led model. Repository administrators appoint
maintainers through GitHub access controls; issue participation does not grant
release authority. Changes to public contracts, authorization, persistence and
release workflows require maintainer review. Contributors should describe
compatibility and include focused tests before requesting review.

Decisions are recorded in pull requests and the changelog. Use issues for proposals
with generic use cases, alternatives and migration effects. Product-specific
policies belong in independently maintained Adapters. Disagreements are resolved
by maintainers with written technical reasons; no private user data is required.

The pre-1.0 Core 0.1.x line and contracts 0.2.x are the current development lines.
Only the latest published patch of a supported line receives fixes; support for
older deployment snapshots is not promised. Public contract breaking changes
require a new minor version before 1.0 and a compatibility note. Adapter authors
must record the exact tested Core/contracts range. See SECURITY.md for reports.

Private vulnerability reporting is enabled on the project repository. Main requires
a reviewed pull request and CI checks for ordinary contributors. Repository
administrators have an explicit bypass and may commit/push directly, while remaining
responsible for testing their changes. These are hosting settings; forks must
configure their own rules. No workflow automatically changes repository visibility.
