# Scheduling flagship architecture

Accepted operator interview: 2026-09-07. Recorded: 2026-09-08. Tracker:
[TIN-2764](https://linear.app/tinyland/issue/TIN-2764).
This is an implementation contract, not a claim of delivered capability.

## Product boundary

Provide a FOSS, self-hosted stateful scheduler for growing service businesses.
The native destination owns booking data in the business's own instance. The
bridge is a transition mechanism: our checkout/UI uses an incumbent scheduler
through browser-driven, verified operations without requiring its paid API tier.
That transition still sends necessary data to the incumbent; it is not a
fully-local-data claim. No existing client is the alpha acceptance target.
Development and QA use operator-controlled synthetic identities.

Design appointments, teams/shared resources, and capacity events as one domain.
Prove solo appointments first, then resource allocation, then capacity events.
A private alpha with declared gaps is the objective, not immediate vendor parity.

## Ownership and graph

| Owner | Owns | Does not own |
| --- | --- | --- |
| scheduling-kit | Domain contracts, native orchestration/adapters, scheduling UI, payment adapters | Browser automation, deployment policy |
| scheduling-bridge | Discovery, browser session/flow, durable job and mutation evidence | Second native booking store or payment authority |
| tinyland-business-pg | Canonical business schema/migrations | Parallel schema copied into kit or a client app |
| tinyland-calendar | Calendar/event/recurrence semantics | Another durable scheduling database |
| tinyland-forms | Existing form/schema integration, including Superforms/Zod | Clinical assertions or fabricated intake answers |
| Tempo SSOT | Disposable client projection/freshness cache | Booking, payment, consent, or authorization authority |
| Business application + owner overlay | Composition, identity, auth policy, Postgres, secrets, backup/restore, ingress | Forked scheduling engine or shared SaaS control plane |
| GF + ci-templates | Admitted execution and exact-head validation evidence | Business workload ownership inside this package |

BCR/Bzlmod remains the delivery authority. Extend existing modules; do not create
another scheduling schema, checkout package, or preview-only Map store to stand
in for the product. Source tags and historical archives remain immutable.
Architectural changes need explicit API/semantic notes and append-only release
receipts; do not disguise them as metadata-only patches.

## Native transaction boundary

Each business owns its app/database/secrets/backups. Application composition
supplies trusted business identity and transaction-scoped database context.
Never infer tenant identity from browser input. Exercise the canonical schema
and its tenant requirements; a hand-written tenantless test schema is not proof.

Postgres is the sole authority for native bookings and bridge job/mutation
receipts. Redis, memory caches, and Tempo may be rebuilt without losing accepted
work or changing a command's disposition. Retire duplicate durable Redis lanes
only with migration/reconciliation evidence.

A native write must atomically:

1. Bind business, operation/idempotency key, normalized command, and intended
   resource allocation. Same key with a different command is a conflict.
2. Lock the affected resource/time scope deterministically; validate current
   service, provider eligibility, hours, lead time, buffers, occupancy, and holds
   in that transaction.
3. Apply the change and store its result/receipt together. Retry returns the
   committed result, never overwrites payment identity or reallocates.

Preserve existing practitioner/local-day locking and write-time overlap checks.
They are useful solo-booking foundations, not team/resource or capacity proof.
Rescheduling validates the destination and commits the move without releasing
the source on failure. Idempotent cancellation restores only its own allocation.

Capacity events need atomic capacity accounting, not simply an exclusive overlap
rule. Appointment/resources and event seats must not be conflated. Use explicit
IANA business timezone plus UTC instants; verify local-day boundaries and DST,
not UTC string slicing. Bound recurrence expansion; unsupported rules fail
explicitly instead of becoming a guessed daily schedule. Move existing recurrence
logic into calendar only with equivalence evidence and removal of its duplicate.

## Booking and payment are two receipts

No UI-generated timestamp, successful HTTP transport, callback completion, or
browser request payload is an authoritative booking or captured payment.

| Observation | Honest disposition |
| --- | --- |
| Server booking receipt, collection owed but not verified | Booked; payment pending collection |
| Server booking receipt, explicitly free/waived/no collection required | Booked; no collection owed, not a fabricated payment capture |
| Verified provider capture, no booking receipt | Captured but unbooked; reconcile the original capture, do not charge again |
| Booking receipt plus verified capture matching business/order, required amount, and currency | Booked and paid, each with its own identity |
| Partial capture, amount/currency mismatch, or uncertain business/order binding | Reconcile; presence of two IDs is not payment-in-full evidence |
| Ambiguous submit/capture/refund outcome | Reconciliation required; no blind mutation replay |
| Staff verifies direct/manual collection | Record explicit staff verification before changing collection state |

Keep automated Venmo through PayPal server capture and direct Venmo awaiting
staff verification. The manual adapter's `pending_collection` is not `paid`;
its generated reference is not capture evidence. Existing callbacks lacking a
durable server operation fail closed rather than fabricating confirmation.
A capture reference must survive a booking failure for reconciliation.

Transition uses our checkout and the incumbent booking, preserving the
coupon/100%-off bypass. Bind receipts without requiring a paid Acuity API plan.
Refund is independently observed: failure or ambiguity cannot be swallowed and
described as compensation. Processor and command idempotency are separate,
required boundaries. Sandbox/zero-dollar verification follows operator scratch
scheduler provisioning; no real payment or client-account operation is implied.

## Bridge discovery and failure semantics

Discover services, calendars, forms, addons, prices/currency, duration/buffers,
and capacity semantics dynamically. Reflect practitioner changes without
hand-maintaining element IDs. Preserve provider identities and versioned,
completeness-aware observations: failed/empty scrape is not successful empty
catalog, and unknown is not zero. Unsupported semantics are explicit gates.

Use runtime semantic discovery and transaction verification, not frozen manual
mappings. Revalidate changed offerings/forms before submit. Never invent required
answers or consent. Computer-use assists development/QA only. Automated adapter
generation against an OpenAI-compatible runtime is outside foreseeable scope.

One browser job owns a coherent session across navigation, fill, submit, and
readback. Mutation replay after a crash requires durable journal evidence and
observed reconciliation. Journal read/write failure fails closed; lease expiry
and fencing prevent stale workers completing another worker's job. Missing IDs
or unobserved fields cannot become synthetic confirmed/paid receipts. Retrying
an uncertain booking must not recapture payment.

## UI, intake, and future assurance

Converge on existing SvelteKit/Skeleton v5+ and tinyland-forms Superforms/Zod,
with compatible versions resolved in the Bazel graph. One explicit checkout state
machine composes server capabilities; avoid duplicate UI/test-only state machines.
A peer dependency or unimplemented method does not establish support.

MVP intake is configured fields, explicit answers, and explicit consent, not
hard-coded clinical questions. Design ownership, authorization, retention,
export/restore, auditability, and controlled federation boundaries now. Exclude
SOAP workflows and HIPAA/equivalent compliance claims from alpha and beta.
Architecture readiness is not assurance; claims require actual audits/backing.

## Current source gaps and proof gates

Source baseline: kit `ad32f5f6e154de427870b4c625eef22d9e704bee`.
This document and authority PR #125 do not change runtime behavior.

| Slice | Current source gap | Required evidence |
| --- | --- | --- |
| Receipt truth | HybridCheckoutDrawer fabricates manual/callback-absent success; pipeline accepts failed payment results and swallows refund failure | Fail before charge on missing capability; no synthetic booking; captured-but-unbooked distinct from pending collection |
| Native composition | Optional transaction runner; separate payment-stamp write; tenant wiring depends on consumer | Actual business-pg schema + trusted scope; create/read/reschedule/cancel/retry/export and concurrent conflicts on Postgres |
| Teams/resources/events | Native provider selection solo/default-oriented; calendar types do not prove atomic capacity | Resource eligibility/allocation and bounded capacity under concurrent writers |
| Bridge | Interface parity does not prove browser session/journal/dynamic discovery | Scratch observation -> discovery/edit -> availability -> submit -> provider readback; ambiguous replay rejected |
| UI/intake | Clinical hard-coding, optional callbacks, multiple state machines, Skeleton v4 peer | Agnostic reference UI against real commands, explicit consent, honest recovery states |
| Delivery | Historical cache-only workflow and BCR receipts | Admitted exact-head GF validation; clean new BCR consumer; owner-overlay proof |

These are acceptance gates, not runtime SLO promises. Measure latency, throughput,
restore time, and failure recovery on the admitted substrate before ratifying
numerical objectives. Report source, test, runtime, release, and adoption evidence
separately. Historical synthetic booking proof remains valid for its recorded
scope; it does not authorize client QA or go-live.

First tranche: design/truth correction and minimal receipt-integrity fix. Next:
canonical native composition and bridge discovery/session integrity, adversarially
reviewed before expansion. Linear owns dated five-/ten-hour and four-week goals;
this package does not duplicate the live schedule.
