# SchedulingAdapter Parity Matrix

Per-method truth for the `SchedulingAdapter` contract
([`src/adapters/types.ts`](https://github.com/tinyland-inc/scheduling-kit/blob/main/src/adapters/types.ts))
across the three production lanes. Every claim cites a test ID
(`file :: test name`), not an adjective. Where no test exists, the cell says
so — see [Evidence gaps](#evidence-gaps).

## Evidence baseline

| Source | Ref | Commit |
| --- | --- | --- |
| `scheduling-kit` (this repo) | `main` | `45f3f8d` |
| `scheduling-bridge` | `origin/main` | `fc1c328` |
| MassageIthaca (adopter "MI") | `github/main` | `7b9c910` (2026-07-03) |
| software.tinyland.dev-booking (adopter) | `main` | `57da10b` |

Compiled 2026-07-03. Line numbers refer to those commits.

## Legend

- **REAL** — the method performs the actual backend operation (Postgres
  write/read, Acuity REST call, or bridge-proxied browser read) and a test
  exercises that path.
- **ADVISORY** — the method is a stub, static response, no-op, or intentional
  always-fail kept for interface parity; correctness is owned elsewhere
  (typically by the backing scheduler's final booking conflict semantics, per
  the interface doc on `softHoldSlot`).
- **TOMBSTONED** — the method's wire endpoint answers `410 ASYNC_REQUIRED`;
  the real operation exists only on the async job protocol
  (`POST /booking/jobs` → `runFlow`), outside the 17-method interface.
- *(untested)* — the marked behavior is readable in source but no test cites
  it; listed in [Evidence gaps](#evidence-gaps).

Lanes:

- **homegrown** — kit `createHomegrownAdapter`
  (`src/adapters/homegrown.ts`, direct Postgres).
- **acuity** — kit `createAcuityAdapter`
  (`src/adapters/acuity.ts`, Acuity REST API v1).
- **acuity + bridge** — scheduling-bridge remote wizard lane: client
  `createRemoteWizardAdapter` (`src/shared/remote-adapter.ts`) → bridge server
  (`src/server/handler.ts`) → wizard adapter (`src/adapters/acuity/wizard.ts`).
  All bridge paths are in the `scheduling-bridge` repo.

Test file shorthand:

| ID | File (repo) |
| --- | --- |
| HG | `src/adapters/__tests__/homegrown-adapter.test.ts` (kit) |
| AE | `src/adapters/__tests__/availability-engine.test.ts` (kit) |
| AT | `src/tests/unit/adapters/acuity-transformers.test.ts` (kit) |
| AI | `tests/integration/acuity.test.ts` (kit) |
| PL | `src/tests/unit/core/pipelines.test.ts` (kit) |
| RA | `src/shared/__tests__/remote-adapter.test.ts` (bridge) |
| SC | `src/shared/__tests__/acuity-service-catalog.test.ts` (bridge) |
| AD | `src/server/__tests__/availability-dates-cache.test.ts` (bridge) |
| AS | `src/server/__tests__/availability-slots-cache.test.ts` (bridge) |
| BP | `src/server/__tests__/booking-create-with-payment.test.ts` (bridge) |
| AN | `src/server/__tests__/async-endpoints.test.ts` (bridge) |
| FR | `src/server/__tests__/flow-runner.test.ts` (bridge) |
| RS | `src/server/__tests__/flow-resume.test.ts` (bridge) |

The 17-method surface itself is pinned by
HG :: `exposes all 16+1 SchedulingAdapter methods`, which enumerates exactly
the methods below.

## The matrix

| # | Method | homegrown | acuity (REST) | acuity + bridge |
| --- | --- | --- | --- | --- |
| 1 | `getServices` | **REAL** — HG :: `returns active services mapped to Service domain type` | **REAL** — AT :: `transforms appointment type to Service` | **REAL** — static catalog or `GET /services`. Server: SC :: `uses static services without touching live loaders`; client wire (indirect): RA :: `works correctly when no custom headers are provided`. No route-level HTTP test (gap G1). |
| 2 | `getService` | **REAL** — HG :: `resolves service by UUID`; HG :: `resolves service by acuityId (non-UUID string)` | **REAL** — AT :: `returns NOT_FOUND for unknown service`; AI :: `returns error for unknown resources` | **REAL** — catalog lookup or `GET /services/:id`. Same citations as `getServices`; no route-level test (gap G1). |
| 3 | `getProviders` | **REAL** — HG :: `returns the default practitioner as a Provider` | **REAL** — AT :: `transforms calendar to Provider` | **ADVISORY** — hardcoded `Default Provider` stub, `remote-adapter.ts:207`. *(untested — gap G2)* |
| 4 | `getProvider` | **REAL** — HG :: `returns a specific provider by ID` | **REAL** — AT :: `returns NOT_FOUND for unknown provider` | **ADVISORY** — static stub, `remote-adapter.ts:216`. *(untested — gap G2)* |
| 5 | `getProvidersForService` | **REAL** — HG :: `delegates to getProviders (solo practice)` | **REAL** — implemented at `acuity.ts:240`. *(untested — gap G3)* | **ADVISORY** — static stub, `remote-adapter.ts:225`. *(untested — gap G2)* |
| 6 | `getAvailableDates` | **REAL** — engine: AE :: `getDatesWithAvailability` › `returns only days with business hours` (adapter wiring pinned only by the HG shape test) | **REAL** — AT :: `transforms availability dates`; AI :: `returns dates within the requested range` | **REAL** — `POST /availability/dates`: AD :: `queues the next month after a successful date request`; AD :: `serves a cached month from Redis and queues the following month` |
| 7 | `getAvailableSlots` | **REAL** — engine: AE :: `generates slots for a 5-hour window with 60min duration at 30min intervals`; AE :: `removes slots that overlap with bookings` | **REAL** — AT :: `transforms availability times to TimeSlot`; AI :: `returns time slots for a specific date` | **REAL** — `POST /availability/slots`: AS :: `serves repeated slot requests from Redis without rereading Acuity` |
| 8 | `checkSlotAvailability` | **REAL** — engine: AE :: `isSlotAvailable` › `returns true for an open slot within hours` | **REAL** — AT :: `checkSlotAvailability returns boolean`; AI :: `checkSlotAvailability returns boolean` | **REAL** — `POST /availability/check` does a genuine slot read + membership match (`wizard.ts` slot-membership path), but no route-level test exists (gap G4). |
| 9 | `softHoldSlot` | **REAL** — HG :: `inserts an advisory soft hold and returns SlotSoftHold`; with `withTransaction`, practitioner-day locking makes hold acquisition an atomic pre-payment admission gate and the Postgres concurrency test proves only one same-slot hold wins | **REAL** — Acuity blocks API: AT :: `transforms block to SlotSoftHold`; AT :: `requires provider ID for soft hold`; AI :: `creates soft hold (block) for slot protection` | **ADVISORY-ONLY, ALWAYS-FAILS** — `Effect.fail(ReservationError BLOCK_FAILED)` at `remote-adapter.ts:263` and `wizard.ts:304`. Kit pipeline tolerates unsupported holds but propagates `SLOT_TAKEN` before payment. No bridge test asserts the failure itself (gap G5). See note below. |
| 10 | `releaseSoftHold` | **REAL** — HG :: `sets releasedAt on the soft hold` | **REAL** — `DELETE /blocks/:id`: AI :: `creates soft hold (block) for slot protection` (asserts block count 1 → 0 after release) | **ADVISORY** — no-op `Effect.succeed(undefined)`, `remote-adapter.ts:271`. *(untested — gap G5)*. Pipeline-level call evidence (mock): PL :: `releases soft hold on payment intent failure`. |
| 11 | `createBooking` | **REAL** — HG :: `resolves service, finds client, gets practitioner, inserts booking`; idempotency: HG :: `replays the existing booking for a duplicate idempotency key without a second insert`; write safety: practitioner-day transaction lock + occupied re-read reject same-slot and overlapping concurrent writers with `SLOT_TAKEN` | **REAL** — AI :: `creates and cancels a booking` | **TOMBSTONED** — `POST /booking/create` answers `410 ASYNC_REQUIRED` (`handler.ts:1373`, delegating to the paid-route tombstone at `handler.ts:1376`). Real bookings run only via async jobs: AN :: `enqueues paid booking commands without running browser automation in the request`; FR :: `produces the booking and the full journal evidence trail on success`. The unpaid tombstone itself has no dedicated test (gap G6). |
| 12 | `createBookingWithPaymentRef` | **REAL** — creates then stamps `paymentRef`/`paymentMethod`/`paymentStatus` (`homegrown.ts`), but only the HG shape test pins it *(behavior untested — gap G7)* | **REAL** — AT :: `includes payment ref from notes` | **TOMBSTONED** — `410 ASYNC_REQUIRED`: BP :: `rejects the synchronous paid booking endpoint so consumers migrate to async jobs`; BP :: `does not run the old sync endpoint even when a request-scoped coupon is present`. Real path is the async job protocol (same AN/FR citations as #11), with segment-boundary resume (note below). |
| 13 | `getBooking` | **REAL** — HG :: `joins booking, service, client, and practitioner data` | **REAL** — AT :: `transforms appointment to Booking` | **ADVISORY** — `NOT_IMPLEMENTED` fail, `remote-adapter.ts:291` / `wizard.ts:339`. *(untested — gap G8)* |
| 14 | `cancelBooking` | **REAL** — HG :: `sets status to cancelled` | **REAL** — AI :: `creates and cancels a booking` | **ADVISORY** — `NOT_IMPLEMENTED` fail, `remote-adapter.ts:294` / `wizard.ts:342`. *(untested — gap G8)* |
| 15 | `rescheduleBooking` | **REAL** — HG :: `updates datetime and returns refreshed booking`; the target slot is transaction-locked and revalidated, while cancelled/completed bookings are rejected | **REAL** — AI :: `handles reschedule operation` | **ADVISORY** — `NOT_IMPLEMENTED` fail, `remote-adapter.ts:297` / `wizard.ts:345`. *(untested — gap G8)* |
| 16 | `findOrCreateClient` | **REAL** — HG :: `returns existing client with isNew=false and updates info`; HG :: `creates new client when email not found` | **REAL** — AT :: `finds existing client by email`; AT :: `indicates new client when email not found` | **ADVISORY** — synthetic `local-${email}` stub, `remote-adapter.ts:304`. *(untested — gap G2)* |
| 17 | `getClientByEmail` | **REAL** — HG :: `returns ClientInfo when client exists`; HG :: `returns null when client not found` | **REAL** — AT :: `returns null for unknown client email` | **ADVISORY** — always `null`, `remote-adapter.ts:307`. *(untested — gap G2)* |

The kit also ships a Cal.com adapter (`src/adapters/calcom.ts`); it is not a
production lane and both soft-hold methods are `notImplemented` there. Out of
scope for this matrix.

## Verified prompt-03 flags

### Bridge `softHoldSlot` is advisory-only and currently failing — confirmed, with nuance

Both bridge implementations return a **failed Effect on every call** —
`Errors.reservation('BLOCK_FAILED', 'Advisory soft holds are not supported…')`
at `remote-adapter.ts:263–270` and `wizard.ts:304–311` (bridge `fc1c328`).
The nuance: this is an **intentional always-fail by design**, not a regressing
or flaky test — the interface itself documents soft holds as advisory
(`src/adapters/types.ts:98–105`), and the kit booking pipeline degrades
gracefully for `BLOCK_FAILED`: PL :: `continues without softHold if softHold
fails` proves a booking still completes with `softHold: undefined`.
`SLOT_TAKEN` is not swallowed; it stops before payment. What is missing is any
bridge-side test asserting the `BLOCK_FAILED` failure contract itself (gap G5).

### Bridge resume = segment-boundary replay — confirmed

`src/server/__tests__/flow-resume.test.ts` (bridge) pins exactly this
semantic:

- `replays a fully-journaled dates read from the boundary checkpoint without re-driving the browser`
- `skips journaled segment boundaries and re-runs from the open segment`
- `a journal with no boundary degenerates to re-run-from-navigate (stated, not oversold)`
- effectful-submit guard: `confirmation found: marks the job succeeded with the extracted data and never re-runs submit`
- `ambiguous probe: reconcile_required with step trace, landing observation, and evidence — never re-submits`

So resume replays from the last journaled segment boundary and re-runs the
open segment; reads re-run freely, submits are gated by a confirmation probe,
and a boundary-free journal honestly degenerates to a full re-run.

## Ascension narrative

The kit's stated adopter arc (`AGENTS.md`): keep the live business running →
introduce the middleware-backed off-ramp → move toward homegrown when the
business is ready. Concretely the rungs are **acuity (vendor-hosted)** →
**acuity + bridge (off-ramp)** → **homegrown (destination)**. Adopter truth as
of the baseline commits:

| Adopter | Rung(s) in production | Evidence |
| --- | --- | --- |
| **MassageIthaca (MI)** | All three modes, selected at runtime: `resolveBackend` picks `homegrown` \| `acuity` (`src/lib/server/scheduling-backend.ts:43`), and acuity splits into **local** (in-process Playwright) vs **remote** (bridge proxy when `SCHEDULING_BRIDGE_URL` is set; K8s lanes must be remote) in `src/lib/server/scheduling.ts:4–16`. Prod/beta are pinned to acuity; alpha runs homegrown. | `src/tests/scheduling-runtime.test.ts` :: `forces beta and prod onto acuity regardless of env-selected backend`; :: `keeps alpha on explicit homegrown while generated previews use env selection`; :: `refuses local Acuity browser fallback in K8s environments` (MI `github/main` @ `7b9c910`) |
| **software.tinyland.dev-booking** | Homegrown only — born on the destination rung; no Acuity, no bridge, by policy. | `src/lib/server/scheduling.ts:3–15` ("Backend: homegrown only. No Acuity, no scheduling-bridge…"); live proof `e2e/book.spec.ts` :: `a real booking lands in the calendar with a captured event UID` (proven run 2026-07-02T01:12Z, event UID `ca276443-2241-4e9c-9bea-1af4f66a71c0`, confirmation `MI-YGLB5Q`) |

Precision note on "MI resolveBackend three modes": `resolveBackend` itself
returns **two** backend values (`homegrown` \| `acuity`); the **three
effective runtime modes** (homegrown / acuity-local / acuity-remote) come from
`getSchedulingKit`'s mode split on `SCHEDULING_BRIDGE_URL` and the K8s
environment check, one layer above `resolveBackend`.

## Evidence gaps

Claims in this matrix that could **not** be backed by a citing test at the
baseline commits:

- **G1** — bridge `GET /services` / `GET /services/:id`: no route-level HTTP
  test. The catalog behind them is tested (SC) and the client wire is
  exercised indirectly by RA header tests, but no test drives the route.
- **G2** — bridge advisory stubs for `getProviders`, `getProvider`,
  `getProvidersForService`, `findOrCreateClient`, `getClientByEmail`: static
  behavior readable at `remote-adapter.ts:207–232, 304–307`, zero tests.
- **G3** — kit acuity `getProvidersForService` (`acuity.ts:240`): implemented,
  no unit or integration test names it.
- **G4** — bridge `POST /availability/check`: real slot-read + membership
  matching in source, no route-level test (only `handler.ts` / `health.ts` /
  `remote-adapter.ts` reference the path).
- **G5** — bridge soft-hold contract: no test asserts `softHoldSlot` fails
  `BLOCK_FAILED` or that `releaseSoftHold` is a successful no-op; the graceful
  fallback is proven only kit-side (PL).
- **G6** — the unpaid `/booking/create` tombstone shares
  `handleDeprecatedSyncPaymentBooking` (`handler.ts:1373–1384`) but only the
  paid route has a dedicated tombstone test (BP).
- **G7** — homegrown `createBookingWithPaymentRef`: real implementation, but
  only the HG shape test pins its existence; no behavioral test verifies the
  payment-field stamping.
- **G8** — bridge `getBooking` / `cancelBooking` / `rescheduleBooking`
  `NOT_IMPLEMENTED` failures: untested.
