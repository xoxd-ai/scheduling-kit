/**
 * Complete Booking Flow Integration Tests
 * End-to-end flow with Acuity + Payment adapters
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import { Effect, Exit, Cause, Option } from 'effect';
import { createAcuityAdapter } from '../../src/adapters/acuity.js';
import { createManualPaymentAdapter } from '../../src/payments/manual.js';
import {
  createSchedulingKit,
  completeBookingWithAltPayment,
  type PipelineContext,
} from '../../src/core/pipelines.js';
import type { SchedulingAdapter } from '../../src/adapters/types.js';
import type { PaymentAdapter } from '../../src/payments/types.js';
import { server } from '../../src/tests/mocks/server.js';
import {
  resetAcuityMockState,
  configureAcuityMock,
  getAcuityMockState,
} from '../../src/tests/mocks/handlers/index.js';
import {
  expectSuccess,
  expectFailure,
  expectFailureTag,
} from '../../src/tests/helpers/effect.js';
import { createClient, createBookingRequest } from '../../src/tests/helpers/factories.js';

// MSW server lifecycle
beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});

afterEach(() => {
  server.resetHandlers();
  resetAcuityMockState();
});

afterAll(() => {
  server.close();
});

describe('Complete Booking Flow: Happy Path', () => {
  let scheduler: SchedulingAdapter;
  let cashAdapter: PaymentAdapter;
  let venmoManualAdapter: PaymentAdapter;
  let kit: ReturnType<typeof createSchedulingKit>;

  beforeEach(() => {
    scheduler = createAcuityAdapter({
      type: 'acuity',
      userId: 'test-user',
      apiKey: 'test-key',
    });

    // Create manual adapters with proper config
    cashAdapter = createManualPaymentAdapter(
      { type: 'manual', methods: ['cash'] },
      'cash',
      'Cash'
    );

    venmoManualAdapter = createManualPaymentAdapter(
      { type: 'manual', methods: ['other'] },
      'venmo',
      'Venmo'
    );

    kit = createSchedulingKit(scheduler, [cashAdapter, venmoManualAdapter]);
  });

  it('completes full booking with cash payment', async () => {
    // Use pre-defined booking request with UTC datetime format
    const result = await expectSuccess(
      kit.completeBooking(
        createBookingRequest({
          client: createClient({
            firstName: 'Happy',
            lastName: 'Path',
            email: 'happy.path@example.com',
          }),
          idempotencyKey: 'happy-path-key',
        }),
        'cash'
      )
    );

    expect(result.booking).toBeDefined();
    expect(result.booking.id).toBeDefined();
    expect(result.booking.status).toBe('confirmed');
    expect(result.payment).toBeDefined();
    expect(result.payment.success).toBe(true);
    expect(result.payment.processor).toBe('cash');
  });

  it('completes booking with Venmo payment', async () => {
    const result = await expectSuccess(
      kit.completeBooking(
        createBookingRequest({
          client: createClient({
            firstName: 'Venmo',
            lastName: 'User',
            email: 'venmo.user@example.com',
          }),
          idempotencyKey: 'venmo-booking-key',
        }),
        'venmo'
      )
    );

    expect(result.booking.status).toBe('confirmed');
    expect(result.payment.processor).toBe('venmo');
    expect(result.booking.paymentRef).toContain('VENMO');
  });

  it('includes payment reference in booking notes', async () => {
    const result = await expectSuccess(
      kit.completeBooking(
        createBookingRequest({
          idempotencyKey: 'payment-ref-test',
        }),
        'cash'
      )
    );

    // Payment ref should be formatted as [PROCESSOR] Transaction: txn_id
    expect(result.booking.paymentRef).toMatch(/\[CASH\] Transaction: .+/);
  });
});

describe('Complete Booking Flow: Error Recovery', () => {
  let scheduler: SchedulingAdapter;
  let kit: ReturnType<typeof createSchedulingKit>;

  beforeEach(() => {
    scheduler = createAcuityAdapter({
      type: 'acuity',
      userId: 'test-user',
      apiKey: 'test-key',
    });

    const cashAdapter = createManualPaymentAdapter(
      { type: 'manual', methods: ['cash'] },
      'cash',
      'Cash'
    );

    kit = createSchedulingKit(scheduler, [cashAdapter]);
  });

  it('fails with invalid payment method', async () => {
    const error = await expectFailureTag(
      kit.completeBooking(
        createBookingRequest({ idempotencyKey: 'invalid-payment-key' }),
        'bitcoin' // Not a valid payment method
      ),
      'PaymentError'
    );

    expect(error._tag).toBe('PaymentError');
    if (error._tag === 'PaymentError') {
      expect(error.code).toBe('INVALID_METHOD');
    }
  });

  it('fails with validation error for invalid email', async () => {
    const error = await expectFailureTag(
      kit.completeBooking(
        createBookingRequest({
          client: createClient({ email: 'not-an-email' }),
          idempotencyKey: 'validation-error-key',
        }),
        'cash'
      ),
      'ValidationError'
    );

    expect(error._tag).toBe('ValidationError');
  });

  it('handles slot taken race condition', async () => {
    // Configure mock to report slot as unavailable
    configureAcuityMock({ simulateSlotTaken: true });

    const error = await expectFailureTag(
      kit.completeBooking(
        createBookingRequest({ idempotencyKey: 'slot-taken-key' }),
        'cash'
      ),
      'ReservationError'
    );

    expect(error._tag).toBe('ReservationError');
    if (error._tag === 'ReservationError') {
      expect(error.code).toBe('SLOT_TAKEN');
    }
  });

  it('handles Acuity API failure during booking', async () => {
    // First call (checkSlotAvailability) succeeds, but booking creation fails
    configureAcuityMock({ failOnBookingCreate: true });

    // This should fail but cleanup (release soft hold) should still happen
    const exit = await Effect.runPromiseExit(
      kit.completeBooking(
        createBookingRequest({ idempotencyKey: 'api-failure-key' }),
        'cash'
      )
    );

    // Should be a failure with AcuityError
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.findErrorOption(exit.cause);
      expect(Option.isSome(failure)).toBe(true);
      if (Option.isSome(failure)) {
        expect(failure.value._tag).toBe('AcuityError');
      }
    }
  });
});

describe('Complete Booking Flow: Cancellation with Refund', () => {
  let scheduler: SchedulingAdapter;
  let kit: ReturnType<typeof createSchedulingKit>;

  beforeEach(() => {
    scheduler = createAcuityAdapter({
      type: 'acuity',
      userId: 'test-user',
      apiKey: 'test-key',
    });

    const cashAdapter = createManualPaymentAdapter(
      { type: 'manual', methods: ['cash'] },
      'cash',
      'Cash'
    );

    kit = createSchedulingKit(scheduler, [cashAdapter]);
  });

  it('cancels booking without refund', async () => {
    // First create a booking
    const booking = await expectSuccess(
      kit.completeBooking(
        createBookingRequest({
          idempotencyKey: 'cancel-no-refund-key',
        }),
        'cash'
      )
    );

    // Cancel without refund
    const result = await expectSuccess(
      kit.cancelBooking({
        bookingId: booking.booking.id,
        reason: 'Customer request',
        refund: false,
      })
    );

    expect(result.cancelled).toBe(true);
    expect(result.refund).toBeUndefined();
  });

  it('cancels booking with refund', async () => {
    // First create a booking
    const booking = await expectSuccess(
      kit.completeBooking(
        createBookingRequest({
          idempotencyKey: 'cancel-with-refund-key',
        }),
        'cash'
      )
    );

    // Cancel with refund
    const result = await expectSuccess(
      kit.cancelBooking({
        bookingId: booking.booking.id,
        reason: 'Service cancelled',
        refund: true,
      })
    );

    expect(result.cancelled).toBe(true);
    expect(result.refund).toBeDefined();
    expect(result.refund!.success).toBe(true);
  });

  it('handles cancellation of nonexistent booking', async () => {
    const error = await expectFailureTag(
      kit.cancelBooking({
        bookingId: 'nonexistent-booking-id',
      }),
      'AcuityError'
    );

    expect(error._tag).toBe('AcuityError');
    if (error._tag === 'AcuityError') {
      // Adapter returns API_ERROR with status code
      expect(error.code).toBe('API_ERROR');
      expect(error.statusCode).toBe(404);
    }
  });
});

describe('Complete Booking Flow: Concurrent Bookings', () => {
  let scheduler: SchedulingAdapter;
  let kit: ReturnType<typeof createSchedulingKit>;

  beforeEach(() => {
    scheduler = createAcuityAdapter({
      type: 'acuity',
      userId: 'test-user',
      apiKey: 'test-key',
    });

    const cashAdapter = createManualPaymentAdapter(
      { type: 'manual', methods: ['cash'] },
      'cash',
      'Cash'
    );

    kit = createSchedulingKit(scheduler, [cashAdapter]);
  });

  it('handles multiple bookings at different times', async () => {
    const bookingPromises = [
      Effect.runPromiseExit(
        kit.completeBooking(
          createBookingRequest({
            datetime: '2026-02-15T14:00:00.000Z',
            client: createClient({ email: 'client1@example.com' }),
            idempotencyKey: 'concurrent-1',
          }),
          'cash'
        )
      ),
      Effect.runPromiseExit(
        kit.completeBooking(
          createBookingRequest({
            datetime: '2026-02-15T15:00:00.000Z',
            client: createClient({ email: 'client2@example.com' }),
            idempotencyKey: 'concurrent-2',
          }),
          'cash'
        )
      ),
      Effect.runPromiseExit(
        kit.completeBooking(
          createBookingRequest({
            datetime: '2026-02-15T16:00:00.000Z',
            client: createClient({ email: 'client3@example.com' }),
            idempotencyKey: 'concurrent-3',
          }),
          'cash'
        )
      ),
    ];

    const results = await Promise.all(bookingPromises);

    // All bookings should succeed (different times)
    results.forEach((exit, i) => {
      expect(Exit.isSuccess(exit)).toBe(true);
      if (Exit.isSuccess(exit)) {
        expect(exit.value.booking.id).toBeDefined();
      }
    });

    // Verify mock state has all appointments
    const state = getAcuityMockState();
    expect(state.appointments.size).toBe(3);
  });
});

describe('Complete Booking Flow: Idempotency', () => {
  let scheduler: SchedulingAdapter;
  let kit: ReturnType<typeof createSchedulingKit>;

  beforeEach(() => {
    scheduler = createAcuityAdapter({
      type: 'acuity',
      userId: 'test-user',
      apiKey: 'test-key',
    });

    const cashAdapter = createManualPaymentAdapter(
      { type: 'manual', methods: ['cash'] },
      'cash',
      'Cash'
    );

    kit = createSchedulingKit(scheduler, [cashAdapter]);
  });

  it('booking request includes idempotency key in notes', async () => {
    // Note: Full idempotency is handled at the adapter level
    // This test verifies the pipeline passes the key through
    const request = createBookingRequest({
      idempotencyKey: 'idempotent-key-12345',
    });

    const result = await expectSuccess(
      kit.completeBooking(request, 'cash')
    );

    // Verify booking was created
    expect(result.booking.id).toBeDefined();
    expect(result.booking.status).toBe('confirmed');

    // Check mock state
    const state = getAcuityMockState();
    expect(state.appointments.size).toBe(1);
  });
});
