# Build And Release

## Remote execution only

Agents never run builds, tests, Bazel/Bazelisk, Nix, development servers, or
containers on Neo. The flake, `.envrc`, and `.bazelversion` describe pinned
tooling, not permission for local execution. Validation belongs to the admitted
GF/ci-templates contract; this package owns no runners or placement policy.

## Authority model

Bazel/Bzlmod is the sole graph and artifact authority. Lockfile translation,
`npm_translate_lock`, and package-manager invocations inside build rules are
implementation mechanics, not extra delivery or operator lanes.

As of 2026-09-08 the checked-in workflow still calls the historical
`js-bazel-package.yml@v3.1.0` cache-backed lane. This is source, not current GF
admission or exact-head validation evidence. Do not treat that historical lane
as a prohibition on current reviewed GF architecture, guess a replacement
template/version, or add a hosted/local fallback. This repo has no publication
workflow. Admission and package correctness are separate evidence gates.

## Delivery doctrine

Package delivery follows one source of truth:

1. The Bzlmod module graph is the canonical (SSOT) delivery mechanism.
   Consumers depend on `tummycrypt_scheduling_kit` through the
   `tinyland-inc/bazel-registry` registry line already present in `.bazelrc`.
2. The source tag and GitHub Release identify the immutable source archive;
   they do not create a second consumer route.
3. `@tummycrypt/scheduling-kit` is the JavaScript import identity inside the
   Bazel artifact, not an npm provider claim.
4. npmjs and GitHub Packages are historical surfaces only. They are not current
   delivery evidence, gates, or supported consumer aliases.

## Validation evidence

Use registered Bazel targets through the admitted GF contract. Missing target
registration or admission is an evidence gap, not permission to execute an
internal package-manager script directly. Cache artifacts, historical receipts,
and a skipped database suite do not establish current native lifecycle proof.
Record the exact SHA and actual remote results; do not poll or repeatedly
dispatch an unadmitted lane. Keep private execution topology out of public docs.

## Release metadata guardrails

When you change release metadata, keep these aligned:

- `package.json`
- `MODULE.bazel`
- `BUILD.bazel`

Version drift across those files is a bug.

## Release Checklist

Before cutting a package release, verify these surfaces together:

- exact version identity across `package.json`, `MODULE.bazel`, and `BUILD.bazel`
- GF validation of `//:pkg` and the real-PostgreSQL concurrency proof
- source tag and GitHub Release resolving to the intended signed commit
- append-only Bazel registry entry in `tinyland-inc/bazel-registry`
- isolated BCR consumer proof for the new module version
- consumer Bzlmod version in bridge and app repositories

Do not add an npmjs or GitHub Packages gate to this checklist. Historical
provider artifacts may be documented as history but cannot establish current
delivery truth.

## Docs and LLM surfaces

`scripts/generate-doc-artifacts.mjs` derives these from repo metadata:

- `docs/generated/package-surface.md`
- `docs/generated/release-metadata.md`
- `llms.txt`

When generated surfaces change, update their source/generator, not a hand-edited
alternate truth. Generation and rendering belong to remote validation; no local
documentation server is authorized.
