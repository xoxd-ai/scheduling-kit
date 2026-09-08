# Testing Guide

This repo uses Vitest for unit, integration, component-like, and live tests,
and Playwright for browser E2E coverage. The package is Effect-based, so the
test helpers and examples in this tree assert on `Effect` success and failure
rather than fp-ts `Either` values.

## Existing test inventory (remote-only)

Script names below identify existing internal configuration, not agent-local
commands. Never run tests/builds/Bazel/Nix/dev servers on Neo. Use registered
Bazel targets through admitted GF; missing registration/admission is an evidence
gap, not permission to execute the package-manager script directly.

| Lane | Command | Primary paths | Notes |
| --- | --- | --- | --- |
| Unit | `pnpm test:unit` | `src/tests/**`, `src/adapters/__tests__/**`, `src/onboarding/__tests__/**` | Fast default lane |
| Integration | `pnpm test:integration` | `tests/integration/**` | Sequential file execution to avoid shared-state races |
| Component | `pnpm test:component` | `tests/e2e/*.test.ts` | jsdom-driven UI tests that share the browser-facing fixture folder |
| Playwright E2E | `pnpm test:e2e` | `tests/e2e/**` | Real browser run across Chromium, Firefox, WebKit, and mobile presets |
| Live | `pnpm test:live` | `tests/live/**` | Explicit opt-in only |

## Current layout

```text
src/tests/
  helpers/        Effect assertions and factory utilities
  fixtures/       Deterministic test data and raw provider payloads
  mocks/          MSW server and handler set
  unit/           Focused unit coverage
  components/     Pure component state coverage
tests/
  integration/    Adapter-level integration flows
  e2e/            Shared browser-facing tests used by Vitest and Playwright
  live/           Real-provider smoke coverage
cassettes/        Recorded provider interactions
```

## Effect-first helper patterns

Use the helpers in `src/tests/helpers/effect.ts` when asserting on package
behavior:

```ts
import { expectSuccess, expectFailureTag } from '../helpers/effect.js';

it('returns a typed validation error', async () => {
  const error = await expectFailureTag(
    completeBookingWithAltPayment(ctx, invalidInput),
    'ValidationError',
  );

  expect(error._tag).toBe('ValidationError');
});
```

Those helpers execute the `Effect`, assert on the `Exit`, and preserve the
typed `SchedulingError` contract exposed by the public API.

## Fixtures, mocks, and recordings

- Use `src/tests/fixtures/**` for deterministic data and raw provider payloads
- Use `src/tests/mocks/**` for MSW-backed HTTP mocks
- Use `src/testing/**` plus `cassettes/**` for record/replay workflows and API diffing

## Live tests

Live tests are intentionally gated and should never become the default CI path.

Live runs require an operator-only scratch scheduler, explicit scope, and the
admitted remote lane. A development task authorizes no client account or real
payment. Keep runs read-only unless synthetic mutations are explicitly scoped.

## Validation expectations

- Exercise changed behavior in existing tests; avoid a parallel test-only state
  machine or redundant source-string assertions as runtime proof.
- Native integration uses canonical business-pg and trusted business scope; a
  hand-built tenantless schema proves only its own fixture.
- Record exact source SHA, remote invocation, selection, results, and skips.
  Source review is not a green test result.
- Provider observations, source tests, release receipts, and adoption are
  separate categories; see [architecture](architecture.md).
