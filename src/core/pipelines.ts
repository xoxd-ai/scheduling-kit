/**
 * Orchestration Pipelines
 * Effect-based composition of scheduling + payment flows
 */

import { Effect, pipe } from 'effect';
import type {
  SchedulingResult,
  BookingRequest,
  Booking,
  SlotSoftHold,
  PaymentResult,
  Service,
  TimeSlot,
  AvailableDate,
} from './types.js';
import { Errors } from './types.js';
import { validateWith, generateIdempotencyKey, withCorrelationId } from './utils.js';
import type { SchedulingAdapter } from '../adapters/types.js';
import type { PaymentAdapter, PaymentRegistry as CanonicalPaymentRegistry } from '../payments/types.js';
import { createPaymentRegistry, toInternalPaymentMethodId, toPublicPaymentMethodId } from '../payments/types.js';
import { z } from 'zod';
import { parsePaymentRef } from './payment-ref.js';
import type { PaymentReference } from './payment-ref.js';

// =============================================================================
// VALIDATION SCHEMAS
// =============================================================================

const ClientInfoSchema = z.object({
  firstName: z.string().min(1, 'First name is required'),
  lastName: z.string().min(1, 'Last name is required'),
  email: z.string().email('Valid email is required'),
  phone: z.string().optional(),
  notes: z.string().optional(),
});

const BookingRequestSchema = z.object({
  serviceId: z.string().min(1),
  providerId: z.string().optional(),
  datetime: z.string().datetime({ local: true }),
  client: ClientInfoSchema,
  paymentMethod: z.string().optional(),
  idempotencyKey: z.string().min(1),
});

// =============================================================================
// PIPELINE CONTEXT
// =============================================================================

export interface PipelineContext {
  readonly scheduler: SchedulingAdapter;
  readonly payments: Map<string, PaymentAdapter>;
  readonly correlationId: string;
}

export interface BookingPipelineInput {
  readonly request: BookingRequest;
  readonly paymentMethod: string;
}

export interface BookingPipelineResult {
  readonly booking: Booking;
  readonly payment: PaymentResult;
  readonly softHold?: SlotSoftHold;
}

// =============================================================================
// MAIN BOOKING PIPELINE
// =============================================================================

/**
 * Complete booking with alternative payment
 *
 * Flow:
 * 1. Validate request
 * 2. Check slot availability
 * 3. Create advisory soft hold when supported
 * 4. Process payment
 * 5. Create booking with payment reference
 * 6. Release soft hold
 * 7. Return result
 *
 * On payment failure: release soft hold, return error.
 * On booking failure: refund payment, release soft hold, return error.
 *
 * The soft hold is an advisory checkout guard, not a correctness boundary.
 * Backends must still rely on their final booking write/rejection semantics,
 * and database-backed adapters should pair this with slot-scoped locks.
 */
export const completeBookingWithAltPayment = (
  ctx: PipelineContext,
  input: BookingPipelineInput
): SchedulingResult<BookingPipelineResult> => {
  const { scheduler, payments, correlationId } = ctx;
  const { request, paymentMethod } = input;

  // Public ids ('card') resolve to internally named adapters ('stripe').
  // Unsupported selections fail with a typed error — never a manual fallback.
  const paymentAdapter =
    payments.get(paymentMethod) ?? payments.get(toInternalPaymentMethodId(paymentMethod));
  if (!paymentAdapter) {
    return Effect.fail(Errors.payment('INVALID_METHOD', `Unknown payment method: ${paymentMethod}`, paymentMethod, false));
  }

  const pipeline = Effect.gen(function* () {
    // Phase A: Validate and check availability
    yield* validateWith(BookingRequestSchema, request);
    const service = yield* scheduler.getService(request.serviceId);
    const available = yield* scheduler.checkSlotAvailability({
      serviceId: request.serviceId,
      providerId: request.providerId,
      datetime: request.datetime,
    });
    if (!available) {
      return yield* Effect.fail(
        Errors.reservation('SLOT_TAKEN', 'This time slot is no longer available', request.datetime)
      );
    }

    // Phase B: Advisory hold (optional; graceful fallback when unsupported)
    const softHold = yield* pipe(
      scheduler.softHoldSlot({
        serviceId: request.serviceId,
        providerId: request.providerId,
        datetime: request.datetime,
        duration: service.duration,
        notes: `Payment pending: ${request.idempotencyKey}`,
      }),
      Effect.map((r) => r as SlotSoftHold | undefined),
      Effect.catch((error) =>
        error._tag === 'ReservationError' && error.code === 'SLOT_TAKEN'
          ? Effect.fail(error)
          : Effect.succeed(undefined as SlotSoftHold | undefined),
      ),
    );

    // Phase C: Process payment (release soft hold on failure)
    const payment = yield* pipe(
      Effect.flatMap(
        paymentAdapter.createIntent({
          amount: service.price,
          currency: service.currency,
          description: `${service.name} - ${request.client.firstName} ${request.client.lastName}`,
          metadata: { serviceId: request.serviceId, datetime: request.datetime, correlationId },
          idempotencyKey: `${request.idempotencyKey}_intent`,
        }),
        (intent) => paymentAdapter.capturePayment(intent.id),
      ),
      Effect.catch((error) => {
        if (softHold) {
          return Effect.flatMap(
            scheduler.releaseSoftHold(softHold.id),
            () => Effect.fail(error),
          );
        }
        return Effect.fail(error);
      }),
    );

    // Phase D: Create booking (refund + release soft hold on failure).
    // Thread the caller's own hold id so the write-time slot gate does not
    // count the Phase B hold as a conflict and fail every held booking.
    // softHoldId is internal pipeline metadata. Discard any same-named value
    // supplied by a caller and inject only the hold acquired in Phase B.
    const { softHoldId: _callerSoftHoldId, ...bookingRequest } = request;
    const requestWithHold: BookingRequest =
      softHold ? { ...bookingRequest, softHoldId: softHold.id } : bookingRequest;
    const booking = yield* pipe(
      scheduler.createBookingWithPaymentRef(
        requestWithHold,
        payment.transactionId,
        paymentAdapter.name,
      ),
      Effect.catch((error) =>
        Effect.gen(function* () {
          yield* Effect.catch(
            paymentAdapter.refund({ transactionId: payment.transactionId, reason: 'Booking creation failed' }),
            () => Effect.succeed(undefined),
          );
          if (softHold) {
            yield* Effect.catch(
              scheduler.releaseSoftHold(softHold.id),
              () => Effect.succeed(undefined),
            );
          }
          return yield* Effect.fail(error);
        }),
      ),
    );

    // Phase E: Cleanup - release soft hold
    if (softHold) {
      yield* Effect.catch(
        scheduler.releaseSoftHold(softHold.id),
        () => Effect.succeed(undefined),
      );
    }

    return { booking, payment, softHold } satisfies BookingPipelineResult;
  });

  return pipe(pipeline, withCorrelationId('completeBookingWithAltPayment', correlationId));
};

// =============================================================================
// AVAILABILITY PIPELINE
// =============================================================================

export interface AvailabilityInput {
  readonly serviceId: string;
  readonly providerId?: string;
  readonly startDate: string;
  readonly endDate: string;
}

export interface AvailabilityResult {
  readonly service: Service;
  readonly dates: AvailableDate[];
}

/**
 * Get availability with service details
 */
export const getAvailabilityWithService = (
  scheduler: SchedulingAdapter,
  input: AvailabilityInput
): SchedulingResult<AvailabilityResult> =>
  Effect.gen(function* () {
    const service = yield* scheduler.getService(input.serviceId);
    const dates = yield* scheduler.getAvailableDates({
      serviceId: input.serviceId,
      providerId: input.providerId,
      startDate: input.startDate,
      endDate: input.endDate,
    });
    return { service, dates };
  });

// =============================================================================
// TIME SLOTS PIPELINE
// =============================================================================

export interface TimeSlotsInput {
  readonly serviceId: string;
  readonly providerId?: string;
  readonly date: string;
}

export interface TimeSlotsResult {
  readonly service: Service;
  readonly date: string;
  readonly slots: TimeSlot[];
}

/**
 * Get time slots with service details
 */
export const getTimeSlotsWithService = (
  scheduler: SchedulingAdapter,
  input: TimeSlotsInput
): SchedulingResult<TimeSlotsResult> =>
  Effect.gen(function* () {
    const service = yield* scheduler.getService(input.serviceId);
    const slots = yield* scheduler.getAvailableSlots({
      serviceId: input.serviceId,
      providerId: input.providerId,
      date: input.date,
    });
    return { service, date: input.date, slots };
  });

// =============================================================================
// CANCELLATION PIPELINE
// =============================================================================

export interface CancellationInput {
  readonly bookingId: string;
  readonly reason?: string;
  readonly refund?: boolean;
}

export interface CancellationResult {
  readonly cancelled: true;
  readonly refund?: {
    readonly success: boolean;
    readonly refundId?: string;
  };
}

/**
 * Cancel booking with optional refund
 *
 * Refund semantics: when `refund: true` and the booking carries a
 * `paymentRef`, the reference is resolved BEFORE any state is mutated:
 *
 * 1. The canonical codec decodes the `[PROCESSOR] Transaction: <id>` wire
 *    format (what Acuity-backed bookings store).
 * 2. If the string does not parse and the backend surfaced the processor as
 *    a structured field (`booking.paymentMethod` — the homegrown adapter
 *    stores the bare transaction id in `paymentRef` and the processor in its
 *    own column), the refund is routed with
 *    `{ processor: booking.paymentMethod, transactionId: booking.paymentRef }`.
 *
 * Only when neither resolves does the pipeline fail with a typed
 * `ValidationError` (field `'paymentRef'`), leaving the booking uncancelled —
 * previously this cancelled the booking and silently reported
 * `refund.success: false`. Callers that want to cancel anyway can retry with
 * `refund: false`. A reference that resolves to a processor with no
 * registered adapter keeps the legacy soft behavior
 * (`refund.success: false`), since the stored data itself is intact.
 */
export const cancelBookingWithRefund = (
  ctx: PipelineContext,
  input: CancellationInput
): SchedulingResult<CancellationResult> => {
  const { scheduler, payments } = ctx;

  return Effect.gen(function* () {
    const booking = yield* scheduler.getBooking(input.bookingId);

    // Resolve the payment reference up front so a refund we cannot honor
    // refuses the operation before the booking is cancelled. Backends that
    // store the reference structurally (homegrown) never wrote the wire
    // format, so a failed parse falls back to their structured halves.
    const storedRef = booking.paymentRef;
    const structuredFallback: PaymentReference | undefined =
      storedRef && booking.paymentMethod
        ? { processor: booking.paymentMethod, transactionId: storedRef }
        : undefined;

    const paymentRef =
      input.refund && storedRef
        ? yield* pipe(
            parsePaymentRef(storedRef),
            Effect.catch((parseError) =>
              structuredFallback ? Effect.succeed(structuredFallback) : Effect.fail(parseError)
            )
          )
        : undefined;

    yield* scheduler.cancelBooking(input.bookingId, input.reason);

    if (!paymentRef) {
      return { cancelled: true } satisfies CancellationResult;
    }

    // Public ids ('card') resolve to internally named adapters ('stripe'),
    // mirroring completeBookingWithAltPayment's resolution order.
    const paymentAdapter =
      payments.get(paymentRef.processor) ??
      payments.get(toInternalPaymentMethodId(paymentRef.processor));

    if (!paymentAdapter) {
      return { cancelled: true, refund: { success: false } } satisfies CancellationResult;
    }

    const transactionId = paymentRef.transactionId;

    const refundResult = yield* pipe(
      paymentAdapter.refund({ transactionId, reason: input.reason ?? 'Booking cancelled' }),
      Effect.catch(() => Effect.succeed({ success: false, refundId: '', originalTransactionId: transactionId, amount: 0, currency: 'USD', timestamp: new Date().toISOString() })),
    );

    return {
      cancelled: true,
      refund: {
        success: refundResult.success,
        refundId: refundResult.refundId,
      },
    } satisfies CancellationResult;
  });
};

// =============================================================================
// FACTORY
// =============================================================================

export interface SchedulingKit {
  readonly scheduler: SchedulingAdapter;
  readonly payments: CanonicalPaymentRegistry;

  completeBooking(
    request: BookingRequest,
    paymentMethod: string
  ): SchedulingResult<BookingPipelineResult>;

  getAvailability(input: AvailabilityInput): SchedulingResult<AvailabilityResult>;

  getTimeSlots(input: TimeSlotsInput): SchedulingResult<TimeSlotsResult>;

  cancelBooking(input: CancellationInput): SchedulingResult<CancellationResult>;
}

export const createSchedulingKit = (
  scheduler: SchedulingAdapter,
  paymentAdapters: PaymentAdapter[]
): SchedulingKit => {
  const registry = createPaymentRegistry();
  for (const adapter of paymentAdapters) {
    registry.register(adapter);
  }

  const payments = new Map<string, PaymentAdapter>();
  for (const a of registry.getAll()) {
    payments.set(a.name, a);
  }
  // Alias the canonical public id ('card' -> stripe adapter) so booking
  // flows driven by public selections resolve the correct processor. Aliases
  // only claim unclaimed ids: a literally named adapter always wins over an
  // alias regardless of registration order, matching registry.get() precedence.
  for (const a of registry.getAll()) {
    const publicId = toPublicPaymentMethodId(a.name);
    if (!payments.has(publicId)) {
      payments.set(publicId, a);
    }
  }

  return {
    scheduler,
    payments: registry,

    completeBooking: (request, paymentMethod) =>
      completeBookingWithAltPayment(
        {
          scheduler,
          payments,
          correlationId: generateIdempotencyKey('booking'),
        },
        { request, paymentMethod }
      ),

    getAvailability: (input) => getAvailabilityWithService(scheduler, input),

    getTimeSlots: (input) => getTimeSlotsWithService(scheduler, input),

    cancelBooking: (input) =>
      cancelBookingWithRefund(
        {
          scheduler,
          payments,
          correlationId: generateIdempotencyKey('cancel'),
        },
        input
      ),
  };
};
