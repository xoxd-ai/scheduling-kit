# scheduling-kit Agent Notes

> **REALITY - 2026-08-28:** `tinyland-inc/scheduling-kit` is the sole
> repository of record. The former `Jesssullivan/scheduling-kit` repository
> was transferred into the organization and now redirects here. The divergent
> stale org mirror is private and archived as
> `tinyland-inc/scheduling-kit-legacy-mirror`; it has no source, CI,
> dependency, tag, or release authority.

This file is the operating brief for AI agents and LLMs working in `@tummycrypt/scheduling-kit`.

## GloriousFlywheel Cache Enrollment (cache-first)

`scheduling-kit` enrolls in the GloriousFlywheel shared Bazel cache (cache-first,
TIN-1997 Option D; pilot tracked as TIN-2110).

- **Do NOT** create runners or a bespoke cache instance. Route everything through
  the shared `tinyland-inc/ci-templates` surface and the existing GloriousFlywheel
  substrate.
- **Do NOT** run raw `bazel build` as validation enrollment. A green build on the
  `tinyland-nix` runner with only `--disk_cache` is **NOT** cache-backed and is
  not enrollment.
- Attach to the shared substrate via the cache-backed lane: the ci-templates
  `js-bazel-package.yml` `cache_backed: true` input, which runs the fail-closed
  contract checker and then `--config=ci-cached --remote_cache=$BAZEL_REMOTE_CACHE
  --remote_upload_local_results=false`. The cache endpoint is injected at runtime
  by the in-cluster `nix-setup` (resolved from cluster DNS); it is never baked
  into `.bazelrc`.
- Self-verify with `scripts/cache-attachment-contract.sh --strict` (or
  `nix develop --command just cache-contract-strict`). The checker fails closed
  on unset/placeholder/non-grpc endpoints, so a misconfigured lane surfaces the
  BLOCKED state instead of silently building local-only.
- REAPI / remote executor is **out of scope** (cache-first only). Never wire
  `--remote_executor` or `--config=executor-backed`.
- Cache attach is **not** org-migration closure. A green cache-backed build does
  not close GF#412 / TIN-1516; org-migration vs widened-ARC-scope remains a
  separate operator decision.

## Repo Role

`scheduling-kit` is the reusable, headless scheduling library.

It should own:

- backend-agnostic scheduling abstractions
- payment adapters
- Effect-powered orchestration types and helpers
- Svelte checkout components
- test utilities and fixtures
- adapter contracts that other sites can reuse

It should **not** own:

- site-specific deployment logic
- Vercel environment heuristics
- Acuity browser automation infrastructure
- Modal deployment control

For browser automation and remote Acuity scraping, use
`@tummycrypt/scheduling-bridge`.

## Strategic Goal

This package is the reusable migration layer for businesses moving away from
Acuity, GlossGenius, and similar closed platforms toward a controlled path:

1. keep the live business running
2. introduce a middleware-backed off-ramp
3. move toward a homegrown backend when the business is ready

The package should be reusable across multiple businesses. Avoid app-specific assumptions.

## Current Tracking

As of `2026-08-27`, release authority and artifact truth are ruled. The active
structural work is keeping source documentation and validation workflows aligned
with the Bzlmod-only delivery contract and the adopter capability boundary.

Active threads:

- `TIN-89` package, Bazel, CI, and dependency truth across shared scheduling
  packages; its current GitHub face is kit issues `#73`/`#75` and bridge issues
  `#76`/`#78`
- the kit-side half of `TIN-88`, the explicit site and backend capability
  contract for reusable adopters, tracked as kit `#79` and bridge `#82`

Closed but still relevant context:

- `TIN-101` completed the mini sprint for toolchain authority and hermetic package convergence
- `TIN-103` records the historical personal-repository authority through
  `0.11.1`; the 2026-08-28 transfer supersedes that repository-location ruling
- `TIN-104` was canceled as a duplicate during that convergence work
- `TIN-165` is done: the tinyland Bazel registry is the package delivery SSOT
- `TIN-3092` is done: the registry carries the immutable scheduling-kit
  `0.11.1` archive and its GF consumer proof
- `TIN-677` is done: HomegrownAdapter takes injected schemas from
  `@tummycrypt/tinyland-business-pg`, with `tinyland-auth-pg` kept only as an
  optional legacy fallback

Current operational truth:

- local development and every source change default to `origin/main`, where
  `origin` is `https://github.com/tinyland-inc/scheduling-kit.git`
- this org branch is the sole functional source and release line; the old
  personal URL is a redirect, never a second remote authority
- current released version is `tummycrypt_scheduling_kit@0.11.1`: source commit
  and lightweight tag `9a00ee387afe1759ebba0c0a67e9246d84b1aa37`,
  GitHub Release `v0.11.1`, and append-only registry receipt
  `cfbb16e6ae957da9e8a25b7418a7871ec815e0a1`
- the Bzlmod module graph through `tinyland-inc/bazel-registry` is the sole
  delivery authority; npmjs and GitHub Packages are historical surfaces, not
  release gates, consumer aliases, or evidence for current versions
- HomegrownAdapter does not require `tinyland-auth-pg`; schemas are injected
  explicitly (canonically from `@tummycrypt/tinyland-business-pg`) and any
  auth-pg fallback stays optional
- `#73` remains open only for explicit historical release-surface
  backfill/documentation around older `0.7.1` / `0.7.2` gaps; it cannot make a
  provider package a current delivery authority
- `tinyland-inc/scheduling-kit-legacy-mirror` is private, archived, and
  fetch-only evidence; never build, merge, publish, tag, or depend on it
- source metadata, git tags, GitHub Releases, and append-only BCR entries are
  distinct evidence; only the registry entry delivers a current module

## Build Truth

Bazel/Bzlmod is the sole package graph and artifact authority. `pnpm-lock.yaml`,
`npm_translate_lock`, and any package-manager invocation inside Bazel remain
dependency-resolution/build mechanics only. They are not agent front doors,
delivery lanes, or release authority.

The repo flake and `.envrc` exist to make those surfaces reproducibly available
from a fresh machine. They are bootstrap tools, not a second packaging
authority.

### Canonical validation and delivery path

Today, the functional validation path is driven by:

- the shared `js-bazel-package` GitHub Actions workflow on GF
- exact-head Bazel/Bzlmod graph validation
- Bazel targets including `//:pkg`
- package output from `./bazel-bin/pkg`
- GF validation only; this repo has no package-publication workflow

The functional source and release repository is
`tinyland-inc/scheduling-kit`. No second release remote exists.

### Bazel role

Bazel exists to provide:

- hermetic graph definition
- version / metadata conformity checks
- cacheability and reproducibility
- the package artifact that GF CI validates

Current target state:

1. release metadata declared once
2. Bazel validates/builds the package artifact
3. GF CI validates and archives that artifact as build evidence
4. an append-only `tinyland-inc/bazel-registry` entry delivers the module
5. downstream apps consume the ruled Bzlmod version

## Bazel Guardrails

When touching release metadata, keep these in sync:

- `package.json`
- `MODULE.bazel`
- `BUILD.bazel`

Version drift across those files is a bug.

Key points:

- `MODULE.bazel` is the Bzlmod entrypoint.
- `BUILD.bazel` describes the hermetic targets.
- `pnpm-lock.yaml` remains important because Bazel translates the lockfile.

## CI / Delivery Truth

### CI

Agent validation runs only on the repository-managed GF workflow. Never run
build, test, Bazel, Nix, a development server, or a container on Neo. Completion
evidence is an exact-head GF receipt over the ruled Bazel targets; a package
manager command is never substitute proof.

### Delivery

Delivery doctrine:

- the Bzlmod module graph through `tinyland-inc/bazel-registry` is the SSOT
  delivery mechanism
- the source tag and GitHub Release identify the archive; neither replaces the
  registry entry or the GF consumer proof
- npmjs and GitHub Packages are historical only; do not add provider
  coordinates, credentials, publish permissions, consumer guidance, or a
  publish workflow back to this repository

Release metadata changes land on the canonical org source line, then register
append-only in `tinyland-inc/bazel-registry`. Never port release work into the
archived legacy mirror or the old personal redirect.

Current runner truth:

- CI uses the shared `tinyland-inc/ci-templates` package validator and the
  existing GF capability labels; no hosted-runner exception is allowed
- do not describe the runner lane as fully proven until repo Actions runner
  visibility and green workflow runs confirm it
- keep private runner topology, cluster names, and apply details out of this
  repository; track those in the private infrastructure repo and Linear

## Effect / Architecture Notes

Use Effect where it improves:

- typed workflow composition
- resource lifecycle
- error semantics
- adapter boundary clarity

Do not overcomplicate simple library code with gratuitous Effect wrapping.

The package's real value is in clear contracts and composable flows, not
ideological FP maximalism.

## Adapter Boundary Rules

These boundaries matter:

- Acuity REST and iframe handoff helpers may live here.
- Browser automation and DOM scraping do **not** belong here.
- App-specific admin UI does **not** belong here.
- Payment adapters should stay business-agnostic and site-agnostic.

If a feature requires Playwright, remote HTTP bridge calls, Modal deployment
details, or selector maintenance, it almost certainly belongs in
`acuity-middleware`, not here.

## Testing Strategy

There is no agent-local validation command on Neo. Select and execute the
repo-managed Bazel targets through GF; keep live-provider validation separately
credentialed and explicitly invoked.

Testing layers:

- unit tests for pure logic
- integration tests for adapter behavior
- component tests for Svelte UI
- live tests only when credentials and provider state are intentionally available

Do not turn live-provider tests into the default CI path.

## Code Patterns

- Keep adapters small and explicit.
- Preserve backend-agnostic abstractions.
- Avoid hard-coding MassageIthaca-specific behavior.
- Keep payment adapter semantics clear about who receives funds and who owns
  platform state.
- Prefer deterministic tests with fixtures/cassettes over flaky live reads.

## Important Files

- `package.json`
- `MODULE.bazel`
- `BUILD.bazel`
- `flake.nix`
- `.envrc`
- `mkdocs.yml`
- `.github/workflows/ci.yml`
- `scripts/generate-doc-artifacts.mjs`
- `docs/generated/**`
- `llms.txt`
- `src/core/**`
- `src/adapters/**`
- `src/payments/**`
- `src/components/**`
- `src/testing/**`

## Guardrails

- Do not move browser automation into this repo.
- Do not let `package.json`, `MODULE.bazel`, and `BUILD.bazel` artifact identity
  drift; this alignment is build integrity, not a second delivery graph.
- Do not reintroduce authority to the old personal redirect or the private
  archived legacy mirror.
- Do not leak site-specific environment logic into library contracts.
- Do not assume MassageIthaca is the only downstream consumer.
