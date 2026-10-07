/**
 * Effect TS Test Helpers
 * Assertion utilities for Effect-based results
 */

import { expect } from 'vitest';
import { Effect, Exit, Cause } from 'effect';
import type { SchedulingError } from '../../core/types.js';

// =============================================================================
// SUCCESS ASSERTIONS
// =============================================================================

/**
 * Run an Effect and assert it succeeds, returning the value
 * @throws AssertionError if the Effect fails
 */
export const expectSuccess = async <A>(
  effect: Effect.Effect<A, SchedulingError>
): Promise<A> => {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  const error = Cause.findErrorOption(exit.cause);
  throw new Error(
    `Expected success but got failure: ${JSON.stringify(error)}`
  );
};

/**
 * Run an Effect and assert it succeeds with a specific value
 */
export const expectSuccessEquals = async <A>(
  effect: Effect.Effect<A, SchedulingError>,
  expected: A
): Promise<void> => {
  const value = await expectSuccess(effect);
  expect(value).toEqual(expected);
};

// =============================================================================
// FAILURE ASSERTIONS
// =============================================================================

/**
 * Run an Effect and assert it fails, returning the error
 * @throws AssertionError if the Effect succeeds
 */
export const expectFailure = async <A>(
  effect: Effect.Effect<A, SchedulingError>
): Promise<SchedulingError> => {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isFailure(exit)) {
    const error = Cause.findErrorOption(exit.cause);
    if (error._tag === 'Some') {
      return error.value;
    }
    throw new Error('Effect failed with a defect, not a typed error');
  }
  throw new Error(
    `Expected failure but got success: ${JSON.stringify(exit.value)}`
  );
};

/**
 * Run an Effect and assert it fails with a specific error tag
 */
export const expectFailureTag = async <A>(
  effect: Effect.Effect<A, SchedulingError>,
  expectedTag: SchedulingError['_tag']
): Promise<SchedulingError> => {
  const error = await expectFailure(effect);
  expect(error._tag, `Expected error tag '${expectedTag}' but got '${error._tag}'`).toBe(
    expectedTag
  );
  return error;
};

// =============================================================================
// SCHEDULING-SPECIFIC ASSERTIONS
// =============================================================================

/**
 * Assert that an Effect fails with AcuityError and optional code
 */
export const expectAcuityError = async <A>(
  effect: Effect.Effect<A, SchedulingError>,
  expectedCode?: string
): Promise<SchedulingError> => {
  const error = await expectFailureTag(effect, 'AcuityError');
  if (expectedCode && error._tag === 'AcuityError') {
    expect(error.code).toBe(expectedCode);
  }
  return error;
};

/**
 * Assert that an Effect fails with PaymentError
 */
export const expectPaymentError = async <A>(
  effect: Effect.Effect<A, SchedulingError>,
  expectedCode?: string,
  expectedRecoverable?: boolean
): Promise<SchedulingError> => {
  const error = await expectFailureTag(effect, 'PaymentError');
  if (error._tag === 'PaymentError') {
    if (expectedCode) {
      expect(error.code).toBe(expectedCode);
    }
    if (expectedRecoverable !== undefined) {
      expect(error.recoverable).toBe(expectedRecoverable);
    }
  }
  return error;
};

/**
 * Assert that an Effect fails with ValidationError
 */
export const expectValidationError = async <A>(
  effect: Effect.Effect<A, SchedulingError>,
  expectedField?: string
): Promise<SchedulingError> => {
  const error = await expectFailureTag(effect, 'ValidationError');
  if (expectedField && error._tag === 'ValidationError') {
    expect(error.field).toBe(expectedField);
  }
  return error;
};

/**
 * Assert that an Effect fails with ReservationError
 */
export const expectReservationError = async <A>(
  effect: Effect.Effect<A, SchedulingError>,
  expectedCode?: 'SLOT_TAKEN' | 'BLOCK_FAILED' | 'TIMEOUT'
): Promise<SchedulingError> => {
  const error = await expectFailureTag(effect, 'ReservationError');
  if (expectedCode && error._tag === 'ReservationError') {
    expect(error.code).toBe(expectedCode);
  }
  return error;
};

/**
 * Assert that an Effect fails with InfrastructureError
 */
export const expectInfrastructureError = async <A>(
  effect: Effect.Effect<A, SchedulingError>,
  expectedCode?: 'NETWORK' | 'TIMEOUT' | 'REDIS' | 'UNKNOWN'
): Promise<SchedulingError> => {
  const error = await expectFailureTag(effect, 'InfrastructureError');
  if (expectedCode && error._tag === 'InfrastructureError') {
    expect(error.code).toBe(expectedCode);
  }
  return error;
};
