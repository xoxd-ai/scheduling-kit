/**
 * Tests for core/utils.ts
 * Effect utility functions
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { Effect, Exit, Cause, pipe } from 'effect';
import { z } from 'zod';

import {
  fromPromise,
  fromPromiseK,
  validateWith,
  validateFields,
  withRetry,
  withTimeout,
  fromOption,
  fromNullable,
  sequenceResults,
  parallelResults,
  recoverWith,
  mapError,
  generateId,
  generateIdempotencyKey,
  withIdempotency,
} from '../core/utils.js';
import { Errors } from '../core/types.js';
import type { SchedulingError } from '../core/types.js';

/** Helper: run an Effect and return the Exit */
const runExit = <A>(effect: Effect.Effect<A, SchedulingError>) =>
  Effect.runPromiseExit(effect);

/** Helper: assert success and return value */
const expectSuccess = async <A>(effect: Effect.Effect<A, SchedulingError>): Promise<A> => {
  const exit = await runExit(effect);
  expect(Exit.isSuccess(exit), `Expected success but got failure`).toBe(true);
  if (Exit.isSuccess(exit)) return exit.value;
  throw new Error('Unreachable');
};

/** Helper: assert failure and return error */
const expectFailure = async <A>(effect: Effect.Effect<A, SchedulingError>): Promise<SchedulingError> => {
  const exit = await runExit(effect);
  expect(Exit.isFailure(exit), `Expected failure but got success`).toBe(true);
  if (Exit.isFailure(exit)) {
    const opt = Cause.findErrorOption(exit.cause);
    if (opt._tag === 'Some') return opt.value;
  }
  throw new Error('Unreachable');
};

const expectErrorMessageContains = (error: SchedulingError, text: string) => {
  if ('message' in error) {
    expect(error.message).toContain(text);
    return;
  }

  throw new Error(`Expected error with message, got ${error._tag}`);
};

describe('Promise Converters', () => {
  describe('fromPromise', () => {
    it('converts successful promise to success', async () => {
      const result = await expectSuccess(
        fromPromise(
          () => Promise.resolve(42),
          () => Errors.infrastructure('UNKNOWN', 'Should not fail')
        )
      );

      expect(result).toBe(42);
    });

    it('converts rejected promise to failure with mapped error', async () => {
      const error = await expectFailure(
        fromPromise(
          () => Promise.reject(new Error('boom')),
          (e) => Errors.infrastructure('UNKNOWN', String(e))
        )
      );

      expect(error._tag).toBe('InfrastructureError');
      expectErrorMessageContains(error, 'boom');
    });

    it('preserves async behavior', async () => {
      let called = false;
      const effect = fromPromise(
        async () => {
          await new Promise((r) => setTimeout(r, 10));
          called = true;
          return 'done';
        },
        () => Errors.infrastructure('UNKNOWN', 'fail')
      );

      expect(called).toBe(false); // lazy
      await Effect.runPromise(effect);
      expect(called).toBe(true);
    });
  });

  describe('fromPromiseK', () => {
    it('creates a function that returns Effect', async () => {
      const fetchUser = fromPromiseK(
        async (id: string) => ({ id, name: 'Test' }),
        () => Errors.infrastructure('NETWORK', 'Failed')
      );

      const result = await expectSuccess(fetchUser('123'));
      expect(result).toEqual({ id: '123', name: 'Test' });
    });
  });
});

describe('Validation', () => {
  describe('validateWith', () => {
    const TestSchema = z.object({
      name: z.string().min(1),
      age: z.number().positive(),
    });

    it('returns success for valid data', async () => {
      const result = await expectSuccess(validateWith(TestSchema, { name: 'John', age: 30 }));
      expect(result).toEqual({ name: 'John', age: 30 });
    });

    it('returns failure with ValidationError for invalid data', async () => {
      const error = await expectFailure(validateWith(TestSchema, { name: '', age: -5 }));
      expect(error._tag).toBe('ValidationError');
    });

    it('transforms data through schema', async () => {
      const schema = z.string().transform((s) => s.toUpperCase());
      const result = await expectSuccess(validateWith(schema, 'hello'));
      expect(result).toBe('HELLO');
    });
  });

  describe('validateFields', () => {
    it('validates multiple fields', async () => {
      const result = await expectSuccess(
        validateFields(
          {
            email: z.string().email(),
            age: z.number().min(18),
          },
          { email: 'test@example.com', age: 25 }
        )
      );

      expect(result).toBeDefined();
    });

    it('collects multiple errors', async () => {
      const error = await expectFailure(
        validateFields(
          {
            email: z.string().email(),
            age: z.number().min(18),
          },
          { email: 'invalid', age: 10 }
        )
      );

      expect(error._tag).toBe('ValidationError');
      expectErrorMessageContains(error, 'email');
      expectErrorMessageContains(error, 'age');
    });
  });
});

describe('Retry & Resilience', () => {
  describe('withRetry', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('returns success on first try if successful', async () => {
      const effect = Effect.succeed(42);
      const retried = withRetry({ maxAttempts: 3 })(effect);

      const result = await expectSuccess(retried);
      expect(result).toBe(42);
    });

    it('retries on infrastructure error', async () => {
      let attempts = 0;
      const effect = Effect.suspend(() => {
        attempts++;
        if (attempts < 3) {
          return Effect.fail(Errors.infrastructure('NETWORK', 'Network error'));
        }
        return Effect.succeed(42);
      });

      const retried = withRetry({ maxAttempts: 3, initialDelayMs: 10 })(effect);

      const resultPromise = Effect.runPromiseExit(retried);
      await vi.runAllTimersAsync();
      const exit = await resultPromise;

      expect(attempts).toBe(3);
      expect(Exit.isSuccess(exit)).toBe(true);
    });

    it('respects maxAttempts', async () => {
      let attempts = 0;
      const effect = Effect.suspend(() => {
        attempts++;
        return Effect.fail(Errors.infrastructure('NETWORK', 'Always fails'));
      });

      const retried = withRetry({ maxAttempts: 2, initialDelayMs: 10 })(effect);

      const resultPromise = Effect.runPromiseExit(retried);
      await vi.runAllTimersAsync();
      const exit = await resultPromise;

      expect(attempts).toBe(2);
      expect(Exit.isFailure(exit)).toBe(true);
    });

    it('does not retry validation errors by default', async () => {
      let attempts = 0;
      const effect = Effect.suspend(() => {
        attempts++;
        return Effect.fail(Errors.validation('field', 'Invalid'));
      });

      const retried = withRetry({ maxAttempts: 3 })(effect);
      await Effect.runPromiseExit(retried);

      expect(attempts).toBe(1); // No retry
    });
  });

  describe('withTimeout', () => {
    it('returns result if completes in time', async () => {
      const effect = Effect.succeed(42);
      const timed = withTimeout<number>(1000)(effect);

      const result = await expectSuccess(timed);
      expect(result).toBe(42);
    });

    it('returns timeout error if too slow', async () => {
      const slowEffect = Effect.promise<number>(() =>
        new Promise((resolve) => setTimeout(() => resolve(42), 500))
      ).pipe(Effect.mapError(() => Errors.infrastructure('UNKNOWN', 'unreachable') as SchedulingError));

      const timed = withTimeout<number>(10)(slowEffect as Effect.Effect<number, SchedulingError>);
      const error = await expectFailure(timed);

      expect(error._tag).toBe('InfrastructureError');
      if (error._tag === 'InfrastructureError') {
        expect(error.code).toBe('TIMEOUT');
      }
    });

    it('allows custom timeout error', async () => {
      const slowEffect = Effect.promise<number>(() =>
        new Promise((resolve) => setTimeout(() => resolve(42), 500))
      ).pipe(Effect.mapError(() => Errors.infrastructure('UNKNOWN', 'unreachable') as SchedulingError));

      const customError = Errors.infrastructure('TIMEOUT', 'Too slow!');
      const timed = withTimeout<number>(10, customError)(slowEffect as Effect.Effect<number, SchedulingError>);
      const error = await expectFailure(timed);

      expect(error._tag).toBe('InfrastructureError');
      if (error._tag === 'InfrastructureError') {
        expect(error.code).toBe('TIMEOUT');
        expect(error.message).toBe('Too slow!');
      }
    });
  });
});

describe('Nullable Helpers', () => {
  describe('fromOption', () => {
    it('converts value to success', async () => {
      const result = await expectSuccess(
        fromOption(() => Errors.validation('test', 'Missing'))(42)
      );
      expect(result).toBe(42);
    });

    it('converts null to failure', async () => {
      const error = await expectFailure(
        fromOption(() => Errors.validation('test', 'Missing'))(null)
      );
      expect(error._tag).toBe('ValidationError');
    });
  });

  describe('fromNullable', () => {
    it('converts value to success', async () => {
      const result = await expectSuccess(
        fromNullable(42, () => Errors.validation('test', 'Missing'))
      );
      expect(result).toBe(42);
    });

    it('converts null to failure', async () => {
      const error = await expectFailure(
        fromNullable(null, () => Errors.validation('test', 'Missing'))
      );
      expect(error._tag).toBe('ValidationError');
    });

    it('converts undefined to failure', async () => {
      const error = await expectFailure(
        fromNullable(undefined, () => Errors.validation('test', 'Missing'))
      );
      expect(error._tag).toBe('ValidationError');
    });
  });
});

describe('Sequencing Helpers', () => {
  describe('sequenceResults', () => {
    it('collects all successful results', async () => {
      const effects = [Effect.succeed(1), Effect.succeed(2), Effect.succeed(3)];
      const result = await expectSuccess(sequenceResults(effects));
      expect(result).toEqual([1, 2, 3]);
    });

    it('fails on first error', async () => {
      const effects = [
        Effect.succeed(1),
        Effect.fail(Errors.validation('test', 'Error at 2')),
        Effect.succeed(3),
      ];
      const error = await expectFailure(sequenceResults(effects));
      expect(error._tag).toBe('ValidationError');
    });
  });

  describe('parallelResults', () => {
    it('runs tasks in parallel', async () => {
      const order: number[] = [];
      const effects = [
        pipe(
          Effect.succeed(1),
          Effect.map((v) => {
            order.push(v);
            return v;
          })
        ),
        pipe(
          Effect.succeed(2),
          Effect.map((v) => {
            order.push(v);
            return v;
          })
        ),
      ];

      const result = await expectSuccess(parallelResults(effects));
      expect(result).toEqual([1, 2]);
    });
  });
});

describe('Error Recovery', () => {
  describe('recoverWith', () => {
    it('recovers from matching error', async () => {
      const effect = Effect.fail(Errors.infrastructure('NETWORK', 'Missing'));
      const recovered = recoverWith<number>(
        (e) => e._tag === 'InfrastructureError' && e.code === 'NETWORK',
        0
      )(effect);

      const result = await expectSuccess(recovered);
      expect(result).toBe(0);
    });

    it('does not recover from non-matching error', async () => {
      const effect = Effect.fail(Errors.validation('test', 'Invalid'));
      const recovered = recoverWith<number>(
        (e) => e._tag === 'InfrastructureError',
        0
      )(effect);

      const error = await expectFailure(recovered);
      expect(error._tag).toBe('ValidationError');
    });
  });

  describe('mapError', () => {
    it('transforms errors', async () => {
      const effect = Effect.fail(Errors.infrastructure('NETWORK', 'Network'));
      const mapped = mapError(
        (e) => Errors.infrastructure('UNKNOWN', `Wrapped: ${'message' in e ? e.message : e._tag}`)
      )(effect);

      const error = await expectFailure(mapped);
      expectErrorMessageContains(error, 'Wrapped:');
    });
  });
});

describe('Idempotency', () => {
  describe('withIdempotency', () => {
    it('executes task when key not found', async () => {
      const store = {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockResolvedValue(undefined),
      };

      const effect = Effect.succeed({ id: '123' });
      const idempotent = withIdempotency(store, 'test-key')(effect);

      const result = await expectSuccess(idempotent);

      expect(store.get).toHaveBeenCalledWith('test-key');
      expect(store.set).toHaveBeenCalledWith('test-key', { id: '123' }, 86400);
      expect(result).toEqual({ id: '123' });
    });

    it('returns idempotency error when key exists', async () => {
      const existingResult = { id: '123' };
      const store = {
        get: vi.fn().mockResolvedValue(existingResult),
        set: vi.fn().mockResolvedValue(undefined),
      };

      const effect = Effect.succeed({ id: '456' });
      const idempotent = withIdempotency(store, 'test-key')(effect);

      const error = await expectFailure(idempotent);

      expect(error._tag).toBe('IdempotencyError');
      expect(store.set).not.toHaveBeenCalled();
    });
  });
});

describe('UUID Generation', () => {
  describe('generateId', () => {
    it('generates valid UUIDs', () => {
      fc.assert(
        fc.property(fc.constant(null), () => {
          const id = generateId();
          // UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
          expect(id).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
          );
        }),
        { numRuns: 100 }
      );
    });

    it('generates unique IDs', () => {
      const ids = new Set(Array.from({ length: 1000 }, () => generateId()));
      expect(ids.size).toBe(1000);
    });
  });

  describe('generateIdempotencyKey', () => {
    it('includes prefix', () => {
      const key = generateIdempotencyKey('booking');
      expect(key).toMatch(/^booking_[0-9a-f-]+$/i);
    });

    it('defaults to "idem" prefix', () => {
      const key = generateIdempotencyKey();
      expect(key).toMatch(/^idem_[0-9a-f-]+$/i);
    });
  });
});

describe('Property-based tests', () => {
  describe('validateWith', () => {
    it('round-trips valid strings', () => {
      fc.assert(
        fc.asyncProperty(fc.string({ minLength: 1 }), async (s) => {
          const schema = z.string().min(1);
          const result = await expectSuccess(validateWith(schema, s));
          expect(result).toBe(s);
        })
      );
    });

    it('rejects invalid emails', () => {
      fc.assert(
        fc.asyncProperty(
          fc.string().filter((s) => !s.includes('@') || !s.includes('.')),
          async (s) => {
            const schema = z.string().email();
            const error = await expectFailure(validateWith(schema, s));
            expect(error._tag).toBe('ValidationError');
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  describe('fromNullable', () => {
    it('always succeeds for non-null values', () => {
      fc.assert(
        fc.asyncProperty(
          fc.anything().filter((x) => x !== null && x !== undefined),
          async (value) => {
            const result = await expectSuccess(
              fromNullable(value, () => Errors.validation('test', 'Missing'))
            );
            expect(result).toBeDefined();
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
