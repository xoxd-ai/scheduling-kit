# Build And Release

## Local bootstrap

The intended fresh-machine path is:

```bash
direnv allow
pnpm install
```

If you are not using `direnv`, enter the same environment with:

```bash
nix develop
```

The dev shell provides:

- Node 22
- pnpm
- Bazel through a Bazelisk wrapper pinned by `.bazelversion`
- MkDocs plus Material
- lightweight repo tooling such as `actionlint`

## Authority model

This repo keeps two deliberately different surfaces:

1. `pnpm` remains the local package-manager and script interface.
2. Bazel defines and builds the JavaScript package artifact validated by CI.

That split is intentional. Nix bootstraps the tools, Bazel models the artifact
graph, and the shared `js-bazel-package` workflow validates
`./bazel-bin/pkg` on GF.

The active workflow contract uses repo-owned runner registration with Tinyland
capability labels. It has read-only permissions and no package provider
coordinate or credential. This repository has no publication workflow. See the
delivery doctrine below.

## Delivery doctrine

Package delivery follows one source of truth:

1. The Bzlmod module graph is the canonical (SSOT) delivery mechanism.
   Consumers depend on `tummycrypt_scheduling_kit` through the
   `xoxd-ai/bazel-registry` registry line already present in `.bazelrc`.
2. The source tag and GitHub Release identify the immutable source archive;
   they do not create a second consumer route.
3. `@tummycrypt/scheduling-kit` is the JavaScript import identity inside the
   Bazel artifact, not an npm provider claim.
4. npmjs and GitHub Packages are historical surfaces only. They are not current
   delivery evidence, gates, or supported consumer aliases.

## Bazel Cache Contract

Local Bazel use defaults to the repo-local disk cache in `.bazelrc`. A local
run is local, non-qualifying: it is a developer diagnostic, not GF validation
evidence. `just flywheel-build` and `just flywheel-test` with `FLYWHEEL=0`
print that label and run:

```bash
bazel build //:typecheck //:pkg //:test
bazel test //:test
```

`.bazelrc` bounds the local client server with `startup --max_idle_secs=120`
and sets `build --remote_local_fallback=false`, so a remote-execution lane,
if one is configured, fails instead of falling back to local execution
(TIN-5770). `FLYWHEEL=1` is the cache-backed lane. It needs
`BAZEL_REMOTE_CACHE` and passes `scripts/cache-attachment-contract.sh --strict`
first. `FLYWHEEL` defaults to `1` when `BAZEL_REMOTE_CACHE` is set and to `0`
when it is unset. Set `FLYWHEEL=0` to force the local path.

Contributor machines can opt into a remote cache by adding a private
`user.bazelrc`; this repository intentionally keeps private cache topology out
of public source. Bazel uploads local results by default, so such a cache
must stay read-only: also set `build --remote_upload_local_results=false`
there, or pass `--config=cache-readonly`. CI remote-cache behavior is owned by
the shared `js-bazel-package` workflow and its GF runner environment. The
public contract is that CI validates and archives the Bazel package artifact
from `./bazel-bin/pkg`; it does not publish that artifact to a package provider.

## Core commands

```bash
pnpm check:release-metadata
pnpm check
pnpm lint
pnpm test:unit
pnpm test:integration
pnpm build
pnpm exec publint
bazel build //:pkg
```

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
- append-only Bazel registry entry in `xoxd-ai/bazel-registry`
- isolated BCR consumer proof for the new module version
- consumer Bzlmod version in bridge and app repositories

Do not add an npmjs or GitHub Packages gate to this checklist. Historical
provider artifacts may be documented as history but cannot establish current
delivery truth.

## Docs and LLM surfaces

Derived docs are generated from repo metadata:

```bash
pnpm docs:generate
pnpm docs:check
pnpm docs:serve
```

Those commands regenerate:

- `docs/generated/package-surface.md`
- `docs/generated/release-metadata.md`
- `llms.txt`

The docs site can also be built as a Nix derivation:

```bash
nix build .#docs
nix flake check
```
