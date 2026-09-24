# OpenApp Domain Language

## App

An administrator-managed catalog entry that users can choose when creating an instance. An App describes product identity, display metadata, status, and authentication behavior; it does not own uploaded packages or a mutable Docker tag.

## Build Strategy

A reviewed, code-owned recipe for producing one runtime image. It declares the named Build Package slots it accepts and the runtime contract its output must satisfy. Its revision selects an exact code adapter, so queued builds cannot silently run newer recipe code. Strategy records are durable metadata; administrators cannot upload executable build commands or Dockerfiles.

## Build Package

An immutable uploaded file occupying one named slot declared by a Build Strategy. It is identified by its size and SHA-256 digest, lives under a deployment-relative storage key, and may be reused by multiple Image Builds or App Revisions. Each package records its own inspected source version and build ID when the strategy exposes them; different slots do not need to share either value. It is not owned by an App.

## Image Build

One durable execution of an exact Build Strategy revision against a frozen set of Build Packages. It records its strategy and package snapshots, progress state, requester, failure reason, and resulting Image Artifact.

## Image Artifact

An immutable validated image produced by an Image Build or imported directly. It records both the human-selectable image reference and the resolved immutable image ID. Build-produced artifacts retain their originating strategy and package snapshot; imported images do not require package slots. It may be deleted only when no App Revision or Container references it.

## App Revision

An internal, monotonically numbered snapshot belonging to one App. Package-based revisions inherit unchanged slots and replace or remove slots selected by an administrator. Image-based revisions reference a directly imported image without requiring build packages. Both paths require a validated Image Artifact before activation. Binding uses the expected current Revision to prevent concurrent administrators from overwriting each other. Existing instances retain their Revision and Image Artifact snapshots until explicitly upgraded. The `AppVersion` type, `app_versions` table, and legacy version routes remain compatibility names; users do not manage semantic App versions in the normal workflow.
