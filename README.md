# @tummycrypt/scheduling-kit

Backend-agnostic scheduling library with Svelte 5 components, pluggable
scheduling adapters, alternative payment support, and Effect-powered workflow
composition.

This repo keeps two intentionally different build surfaces:

- `pnpm` is the local package-manager and script interface
- Bazel defines and builds the JavaScript package artifact validated by CI

The recommended local bootstrap path is the repo flake plus `direnv`, which
makes `pnpm`, `bazel` through Bazelisk, and the docs toolchain available from a
clean shell.

## Features

- **Multiple scheduling backends** -- Acuity REST API, Cal.com, or
  bring-your-own PostgreSQL (HomegrownAdapter)
- **Svelte 5 components** -- ServicePicker, DateTimePicker, ClientForm,
  CheckoutDrawer, and more
- **Payment adapters** -- Stripe, Venmo/PayPal SDK, cash, Zelle, check
- **Availability engine** -- Pure-function slot generation, DST-safe via `Intl.DateTimeFormat`
- **Reconciliation** -- Alt-payment matching and webhook handling
- **Test infrastructure** -- Cassette-based API recording/playback, MSW
  mocking, property-based tests
- **Functional core** -- Effect-powered scheduling flows and typed error handling

## Installation

The Bazel module graph is the canonical delivery mechanism. Depend on the
module through the tinyland Bazel registry:

```starlark
bazel_dep(name = "tummycrypt_scheduling_kit", version = "0.11.1")
```

with the registry line (already in this repo's `.bazelrc`):

```text
common --registry=https://raw.githubusercontent.com/tinyland-inc/bazel-registry/main
```

The append-only registry receipt carrying `0.11.1` and its GF consumer proof is
`cfbb16e6ae957da9e8a25b7418a7871ec815e0a1`. The
`@tummycrypt/scheduling-kit` string remains the JavaScript import identity inside
the Bazel artifact; it is not a provider install route. There is no supported
npmjs or GitHub Packages consumer alias for current releases.

## Development Environment

```bash
direnv allow
pnpm install
```

If `bazel` is missing in your current shell, enter the flake environment with
`nix develop` or let `direnv` load `.envrc`. The dev shell provides a `bazel`
wrapper backed by Bazelisk and pinned by `.bazelversion`.

Peer dependencies (install those you need):

```bash
# Required
pnpm add svelte

# Optional -- for UI components
pnpm add @skeletonlabs/skeleton@5.0.1 @skeletonlabs/skeleton-svelte@5.0.1

# Optional -- for E2E tests
pnpm add -D playwright-core
```

## Release Hygiene

```bash
pnpm check:release-metadata
pnpm check:package
bazel build //:pkg
npm pack --dry-run ./bazel-bin/pkg
```

Those checks keep `package.json`, `MODULE.bazel`, and `BUILD.bazel` artifact
identity aligned. GF runs the same validation against the Bazel-built artifact;
delivery is the separately reviewed append-only BCR entry.

## Documentation

```bash
pnpm docs:generate      # Regenerate derived Markdown and llms surfaces
pnpm docs:check         # Validate generated docs and MkDocs config
pnpm docs:serve         # Local docs preview at http://127.0.0.1:8000
nix build .#docs        # Build the static docs site as a derivation
nix flake check         # Evaluate flake outputs and run lightweight checks
```

## Release Authority

Current reality:

- the functional source and tag line is `Jesssullivan/scheduling-kit`
- `tinyland-inc/scheduling-kit` is now a downstream mirror and validation
  surface, not a second release authority
- source commit, tag, and GitHub Release `v0.11.1` resolve to
  `9a00ee387afe1759ebba0c0a67e9246d84b1aa37`
- the Tinyland Bazel registry carries `tummycrypt_scheduling_kit@0.11.1`; its
  append-only proof receipt is `cfbb16e6ae957da9e8a25b7418a7871ec815e0a1`

Treat `Jesssullivan/main` as the source authority for release metadata changes.
Treat `tinyland-inc/bazel-registry` as delivery authority. Do not assume the two
scheduling-kit `main` branches are equivalent.

The delivery doctrine is:

1. release metadata declared once
2. Bazel defines and builds the JavaScript artifact
3. GF GitHub Actions validates that artifact without provider credentials or
   write permissions
4. the source tag and GitHub Release identify the immutable archive
5. the Bzlmod module graph via `tinyland-inc/bazel-registry` is the sole
   delivery mechanism
6. downstream apps consume the ruled Bzlmod version
7. npmjs and GitHub Packages remain historical surfaces only

## Runner Authority

Package CI uses the shared `js-bazel-package` validator with
`runner_mode: repo_owned` and labels from `PRIMARY_LINUX_RUNNER_LABELS_JSON`.
The PostgreSQL concurrency proof uses the same GF capability class. This repo
has no publish workflow, hosted-runner exception, provider coordinate, package
write permission, or publication credential.

Keep private runner topology and apply details out of this public repo.

## Quick Start

```typescript
import { Effect } from 'effect';
import {
  createSchedulingKit,
  createHomegrownAdapter,
  createStripeAdapter,
  createVenmoAdapter,
} from '@tummycrypt/scheduling-kit';

// Create a scheduling adapter
const scheduler = createHomegrownAdapter({
  withDb: async (fn) => fn(drizzleInstance),
  schemas: {
    content: contentSchema,
    booking: bookingSchema,
  },
  timezone: 'America/New_York',
});

// Create payment adapters
const stripe = createStripeAdapter({
  type: 'stripe',
  secretKey: process.env.STRIPE_SECRET_KEY!,
  publishableKey: process.env.STRIPE_PUBLISHABLE_KEY!,
});

const venmo = createVenmoAdapter({
  type: 'venmo',
  clientId: process.env.PAYPAL_CLIENT_ID!,
  clientSecret: process.env.PAYPAL_CLIENT_SECRET!,
  environment: 'sandbox',
});

// Compose into a scheduling kit
const kit = createSchedulingKit(scheduler, [stripe, venmo]);

// Complete a booking
const result = await Effect.runPromise(
  kit.completeBooking(request, 'stripe')
);
```

## Ownership Boundary

This package owns reusable scheduling contracts, payment adapters, checkout UI,
and Acuity REST plus iframe handoff primitives.

It does **not** own:

- browser automation
- remote Acuity scraping
- Modal deployment/runtime control
- site-specific booking orchestration

If your Acuity flow needs browser automation or remote bridge-backed booking
semantics, that ownership belongs to `@tummycrypt/scheduling-bridge` plus the
adopter app that wires the handoff.

## Adapters

### HomegrownAdapter

Direct PostgreSQL adapter using Drizzle ORM. Replaces third-party scheduling
APIs entirely.

```typescript
import {
  createHomegrownAdapter,
  type HomegrownAdapterSchemas,
} from '@tummycrypt/scheduling-kit/adapters';
import * as contentSchema from '@tummycrypt/tinyland-business-pg/content-schema';
import * as bookingSchema from '@tummycrypt/tinyland-business-pg/booking-schema';

const schemas: HomegrownAdapterSchemas = {
  content: contentSchema,
  booking: bookingSchema,
};

const adapter = createHomegrownAdapter({
  withDb: async (fn) => fn(drizzleInstance),
  schemas,
  timezone: 'America/New_York',
});

// 16 methods: getServices, getAvailability, getSlots, book, cancel,
// reschedule, ...
```

`schemas` is the preferred boundary for reusable adopters. It lets the
homegrown backend use whichever Drizzle schema package owns business and
booking tables. Existing adopters may still omit it if they intentionally use
the legacy optional `@tummycrypt/tinyland-auth-pg` schema exports.

### AcuityAdapter

API-based adapter for Acuity Scheduling (requires Powerhouse plan).
For browser automation and no-API migration flows, use
`@tummycrypt/scheduling-bridge`.

```typescript
import { createAcuityAdapter } from '@tummycrypt/scheduling-kit/adapters';

const config = {
  type: 'acuity' as const,
  userId: process.env.ACUITY_USER_ID!,
  apiKey: process.env['ACUITY_API_KEY']!,  // from Acuity Integrations page
};
const adapter = createAcuityAdapter(config);
```

### CalComAdapter

Stub adapter for future Cal.com integration.

```typescript
import { createCalComAdapter } from '@tummycrypt/scheduling-kit/adapters';

const adapter = createCalComAdapter({
  type: 'calcom',
  apiKey: process.env['CALCOM_API_KEY']!,
  baseUrl: 'https://api.cal.com/v1',
});
```

## Availability Engine

Pure functions for slot generation. DST-safe, timezone-aware, fully tested.

```typescript
import {
  getAvailableSlots,
  isSlotAvailable,
  getDatesWithAvailability,
  getEffectiveHours,
} from '@tummycrypt/scheduling-kit/adapters';

const slots = getAvailableSlots({
  date: '2026-03-22',
  timezone: 'America/New_York',
  hours: [{ dayOfWeek: 6, startTime: '11:00', endTime: '16:00' }],
  overrides: [],
  occupied: [],
  slotDuration: 60,
  bufferMinutes: 15,
});
```

## Components

Svelte 5 components using runes syntax. Skeleton 5 integration for styling (peers `@skeletonlabs/skeleton` and `@skeletonlabs/skeleton-svelte` exactly `5.0.1`).

| Component | Description |
| ----------- | ----------- |
| `ServicePicker` | Service/appointment type selector |
| `DateTimePicker` | Calendar date + time slot picker |
| `ClientForm` | Client info form with Zod validation |
| `PaymentSelector` | Payment method chooser |
| `ProviderPicker` | Practitioner/provider selector |
| `BookingConfirmation` | Post-booking confirmation display |
| `CheckoutDrawer` | Full checkout flow in a slide-out drawer |
| `HybridCheckoutDrawer` | Checkout UI for adopter-provided Acuity handoff |
| `VenmoButton` | Venmo/PayPal payment button |
| `VenmoCheckout` | Full Venmo checkout flow |
| `StripeCheckout` | Stripe Elements checkout |
| `AcuityEmbedHandoff` | Prefilled Acuity iframe handoff with postMessage |

```svelte
<script lang="ts">
  import {
    ServicePicker,
    DateTimePicker,
    ClientForm,
  } from '@tummycrypt/scheduling-kit/components';
</script>

<ServicePicker services={data.services} onselect={handleSelect} />
<DateTimePicker slots={availableSlots} onselect={handleTimeSelect} />
<ClientForm onsubmit={handleSubmit} />
```

## Payment Adapters

```typescript
import {
  createStripeAdapter,
  createVenmoAdapter,
  createCashAdapter,
  createZelleAdapter,
  createCheckAdapter,
  createVenmoDirectAdapter,
} from '@tummycrypt/scheduling-kit/payments';
```

| Adapter | Type | Description |
| --------- | ------ | ------------- |
| `createStripeAdapter` | `stripe` | Stripe Connect with Payment Intents |
| `createVenmoAdapter` | `venmo` | PayPal SDK with Venmo button |
| `createCashAdapter` | `cash` | Cash/in-person manual payment |
| `createZelleAdapter` | `zelle` | Zelle manual payment |
| `createCheckAdapter` | `check` | Check manual payment |
| `createVenmoDirectAdapter` | `venmo-direct` | Venmo deep link (no SDK) |

## Reconciliation

Match alt-payment transactions (Venmo, Zelle, cash) to bookings.

```typescript
import {
  createReconciliationMatcher,
} from '@tummycrypt/scheduling-kit/reconciliation';
```

## Stores

Svelte 5 runes-based checkout state management.

```typescript
import { checkoutStore } from '@tummycrypt/scheduling-kit/stores';
```

## Testing

### Unit Tests

```bash
pnpm test:unit           # Run all unit tests
pnpm test:coverage       # With coverage report
```

### Integration Tests

```bash
pnpm test:integration    # Mocked backend integration tests
```

### Component Tests

```bash
pnpm test:component      # jsdom-based component tests
```

### E2E Tests

```bash
pnpm test:e2e            # Playwright browser tests (starts dev server)
```

### Live Tests

```bash
# Copy .env.test.local.example to .env.test.local and fill in credentials
RUN_LIVE_TESTS=true pnpm test:live
```

### Test Utilities

The `@tummycrypt/scheduling-kit/testing` export provides cassette-based API
recording and playback for deterministic integration tests.

```typescript
import { CassetteRecorder, CassettePlayer } from '@tummycrypt/scheduling-kit/testing';
```

## Development

```bash
pnpm dev                 # Start dev server
pnpm build               # Build package
pnpm check               # TypeScript check
pnpm lint                # ESLint
pnpm test:all            # Run all test suites
pnpm docs:check          # Validate generated docs and MkDocs config
bazel build //:pkg       # Build npm artifact through Bazel
```

## License

MIT -- see [LICENSE](./LICENSE) for details.
