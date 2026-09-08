# scheduling-kit

`@tummycrypt/scheduling-kit` is the reusable scheduling library for practitioner
and small-business migration flows. It packages backend-agnostic scheduling
contracts, payment adapters, Svelte checkout components, onboarding helpers, and
Effect-powered orchestration without taking ownership of browser automation or
site-specific control planes.

## What this repo owns

- Scheduling contracts and adapters
- Alternative payment adapters and capability contracts
- Svelte checkout UI primitives
- Onboarding helpers for Stripe and PayPal/Venmo
- Test fixtures, mocks, and cassette tooling

## What this repo does not own

- Playwright or DOM automation against third-party booking UIs
- Modal deployment/runtime control
- App-specific admin surfaces
- Site-local orchestration policies

Browser automation and remote Acuity scraping belong in
`@tummycrypt/scheduling-bridge` plus the adopter app that drives it.

## Flagship direction and evidence

The [architecture contract](architecture.md) defines the ratified native
scheduling destination and the bridge transition path. It distinguishes required
invariants from current implementation gaps. The [parity matrix](parity-matrix.md)
retains historical source/test evidence; it is not a production-readiness claim.

## Build truth

Bazel/Bzlmod is the sole package graph and artifact authority, delivered through
`tinyland-inc/bazel-registry`. Lockfile translation and package-manager calls
inside the build are implementation mechanics, not another operator or consumer
lane. Agents never run local builds, tests, or development servers on Neo.
Validation must carry an exact-head GF receipt; the historical workflow checked
into this repository does not itself establish current GF admission.

## Where to go next

- [Build & Release](build-and-release.md) for bootstrap, Bazel, Nix, and delivery hygiene
- [Flagship architecture](architecture.md) for native/bridge state authority and acceptance gates
- [Testing](testing.md) for the actual test layout and commands in this tree
- [Tracing](tracing.md) for cassette-based recording and replay details
- [Generated package surface](generated/package-surface.md) for the current export map and source inventory
- [Generated release metadata](generated/release-metadata.md) for version, Bzlmod delivery, and GF validation inputs derived from repo files
