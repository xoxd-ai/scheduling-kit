# scheduling-kit Agent Notes

> **REALITY - 2026-08-28:** `tinyland-inc/scheduling-kit` is the sole
> repository of record. The former `Jesssullivan/scheduling-kit` repository
> was transferred into the organization and now redirects here. The divergent
> stale org mirror is private and archived as
> `tinyland-inc/scheduling-kit-legacy-mirror`; it has no source, CI,
> dependency, tag, or release authority.

This file is the operating brief for AI agents and LLMs working in `@tummycrypt/scheduling-kit`.

## Execution authority and current CI gap

> **REALITY — 2026-09-08:** the checked-in workflow still calls the historical
> `ci-templates@v3.1.0` cache-backed package lane. That source fact is not current
> GF admission, a current execution contract, or an exact-head validation receipt.
> The former cache-first/no-REAPI instruction is superseded; do not use it to
> resist or invent the estate's GF convergence.

- All execution belongs to GloriousFlywheel and its owner overlays, through
  `tinyland-inc/ci-templates`. This package owns no runners or cluster topology.
- Never run local builds, tests, Bazel/Bazelisk, Nix, development servers, or
  containers on Neo. Do not introduce a hosted-runner or local fallback.
- Adopt only the reviewed, admitted GF/template contract. Do not guess a newer
  workflow version, migrate infrastructure here, or describe source enrollment
  as runtime proof. Report missing admission as a separate evidence gate.
- Keep historical cache receipts as history; they do not prove the native
  scheduling lifecycle or qualify a new source head.

## Ratified flagship boundary (2026-09-07; recorded 2026-09-08)

The operator's scheduling-system interview supersedes adopter-first completion
claims. The implementation contract is [Flagship architecture](docs/architecture.md).
Linear TIN-2764 carries the programme and evidence audit; dates belong in Linear.

- Build a FOSS, self-hosted stateful replacement, not only a migration UI.
  Design solo appointments, teams/resources, and capacity events together;
  prove the native solo lifecycle first using synthetic, operator-only data.
- A business owns its app, Postgres, secrets, and backups through its overlay.
  Postgres is the durable authority; Redis and Tempo are disposable projections.
  Reuse `tinyland-business-pg`, calendar, forms, and existing BCR modules.
- Bridge discovery is dynamic and runtime-verified, not a manually frozen list
  of provider DOM IDs. Browser automation stays in scheduling-bridge;
  computer-use is development/QA assistance, never the customer runtime.
- Payment and booking are separate receipts. Preserve automated PayPal-backed
  Venmo and direct Venmo awaiting staff verification; never invent a booking,
  assume a capture, or mark a pending collection paid.
- Intake is agnostic MVP configuration and explicit consent. SOAP workflows and
  HIPAA/compliance claims are excluded from alpha and beta; architecture is not
  an audit or certification. No client participates in platform QA.
- These are accepted design constraints, not claims that the current release
  implements them. No client adoption, provider parity, deployment readiness,
  or performance SLO follows from a source-only or mock-test result.

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

This package is the reusable stateful scheduling system for businesses moving away from
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

The checked-in historical workflow calls `js-bazel-package` and names Bazel
targets including `//:pkg` and output `./bazel-bin/pkg`. This inventory is not
current admission or proof that those targets ran. The required acceptance
evidence is exact-head Bazel/Bzlmod validation through the reviewed, admitted
GF contract. This repo has no package-publication workflow.

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

Playwright and selector maintenance belong in `scheduling-bridge`. Kit may
compose a typed bridge capability but must not absorb its browser lifecycle.
Deployment policy belongs to the business-owned application overlay.

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
