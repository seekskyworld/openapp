# Third-party dependencies

OpenApp source is licensed under Apache-2.0. This does not replace the licenses of dependencies, base images or separately supplied Adapters.

Each exported bundle contains `third-party/backend.cdx.json`, `third-party/frontend.cdx.json` (CycloneDX inventories from the installed npm dependency trees) and corresponding `*-LICENSES.txt` files containing declared licenses and available package-root LICENSE/NOTICE/COPYING texts. Frontend inventory includes its declared build dependencies and may exceed the modules emitted by Vite. Optional packages unavailable on the build host are not included.

The exporter also preserves license sections embedded in package READMEs when there is no standalone license file. Retain these notices when redistributing bundles and review any package marked as lacking license text. Adapters that bundle third-party code must provide their own LICENSE/NOTICE with the required attributions; the exporter includes those files but cannot infer licenses from arbitrary bundled JavaScript. Linux image distributors must also preserve upstream image/OS notices and inventory the actual image built on the target platform.

The inventories are evidence for review, not a legal opinion or a claim that all dependencies share the Core license. npm audit in CI checks advisories separately from licensing.

## Project artwork

`frontend/public/openapp-logo.png` is licensed under [Apache-2.0](LICENSE) with
the project. On 2026-09-20, the project owner confirmed that the artwork is original
or appropriately authorized and may be released under Apache-2.0. This records the
owner's authorization without attributing authorship to a specific person. The
existing artwork and appearance are preserved.
