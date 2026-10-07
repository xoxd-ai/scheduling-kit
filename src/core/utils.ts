/**
 * Effect TS utilities for scheduling-kit
 * Composable helpers for monadic operations
 */

import { Effect, Schedule, Duration, pipe } from 'effect';
import { z } from 'zod';
import type { SchedulingError, SchedulingResult } from './types.js';
import { Errors } from './types.js';

// =============================================================================
// PROMISE → EFFECT CONVERTERS
// =============================================================================

/**
 * Convert a Promise to Effect with error mapping
 */
export const fromPromise = <A>(
  promise: () => Promise<A>,
  onError: (e: unknown) => SchedulingError
): SchedulingResult<A> =>
  Effect.tryPromise({ try: promise, catch: onError });

/**
 * Convert a Promise-returning function with known error type
 */
export const fromPromiseK = <A, Args extends unknown[]>(
  fn: (...args: Args) => Promise<A>,
  onError: (e: unknown) => SchedulingError
) => (...args: Args): SchedulingResult<A> =>
  fromPromise(() => fn(...args), onError);

// =============================================================================
// VALIDATION
// =============================================================================

/**
 * Validate with Zod schema, converting to SchedulingResult
 */
export const validateWith = <T>(
  schema: z.ZodType<T>,
  data: unknown
): SchedulingResult<T> =>
  Effect.try({
    try: () => schema.parse(data),
    catch: (e) => {
      if (e instanceof z.ZodError) {
        const firstError = e.issues[0];
        return Errors.validation(
          firstError?.path.join('.') || 'unknown',
          firstError?.message || 'Validation failed',
          data
        );
      }
      return Errors.validation('unknown', 'Validation failed', data);
    },
  });

/**
 * Validate multiple fields, collecting all errors
 */
export const validateFields = <T extends Record<string, unknown>>(
  validators: { [K in keyof T]: z.ZodType<T[K]> },
  data: Record<string, unknown>
): SchedulingResult<T> => {
  const errors: string[] = [];
  const result: Record<string, unknown> = {};

  for (const [key, schema] of Object.entries(validators)) {
    const parsed = (schema as z.ZodType).safeParse(data[key]);
    if (parsed.success) {
      result[key] = parsed.data;
    } else {
      errors.push(`${key}: ${parsed.error.issues[0]?.message}`);
    }
  }

  if (errors.length > 0) {
    return Effect.fail(Errors.validation('multiple', errors.join('; '), data));
  }

  return Effect.succeed(result as T);
};

// =============================================================================
// RETRY & RESILIENCE
// =============================================================================

export interface RetryConfig {
  readonly maxAttempts: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly backoffMultiplier: number;
  readonly retryOn?: (error: SchedulingError) => boolean;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  initialDelayMs: 1000,
  maxDelayMs: 10000,
  backoffMultiplier: 2,
};

/**
 * Retry an Effect with exponential backoff
 */
export const withRetry = <A>(
  config: Partial<RetryConfig> = {}
) => (effect: SchedulingResult<A>): SchedulingResult<A> => {
  const { maxAttempts, initialDelayMs, maxDelayMs, backoffMultiplier, retryOn } = {
    ...DEFAULT_RETRY_CONFIG,
    ...config,
  };

  const shouldRetry = retryOn ?? ((e: SchedulingError) =>
    e._tag === 'InfrastructureError' && e.code !== 'TIMEOUT'
  );

  // Effect 4: Schedule.intersect is Schedule.max (recur while both recur,
  // using the larger delay), and the input predicate moves to retry's `while`.
  const schedule = Schedule.max([
    Schedule.exponential(Duration.millis(initialDelayMs), backoffMultiplier),
    Schedule.recurs(maxAttempts - 1),
  ]);

  return Effect.retry(effect, { schedule, while: shouldRetry });
};

// =============================================================================
// TIMEOUT
// =============================================================================

/**
 * Add timeout to an Effect
 */
export const withTimeout = <A>(
  timeoutMs: number,
  timeoutError?: SchedulingError
) => (effect: SchedulingResult<A>): SchedulingResult<A> => {
  const error = timeoutError ?? Errors.infrastructure('TIMEOUT', `Operation timed out after ${timeoutMs}ms`);

  return pipe(
    effect,
    Effect.timeoutOrElse({
      duration: Duration.millis(timeoutMs),
      orElse: () => Effect.fail(error),
    }),
  );
};

// =============================================================================
// LOGGING & TRACING
// =============================================================================

export interface LogContext {
  readonly correlationId: string;
  readonly operation: string;
  readonly startTime: number;
}

/**
 * Add correlation ID and timing to operations
 */
export const withCorrelationId = <A>(
  operation: string,
  correlationId: string = crypto.randomUUID()
) => (effect: SchedulingResult<A>): SchedulingResult<A> =>
  Effect.gen(function* () {
    const startTime = Date.now();
    const result = yield* effect;
    const duration = Date.now() - startTime;
    console.debug(`[${correlationId}] ${operation} completed in ${duration}ms`);
    return result;
  }).pipe(
    Effect.tapError((error) =>
      Effect.sync(() => {
        console.error(`[${correlationId}] ${operation} failed:`, error);
      })
    )
  );

// =============================================================================
// NULLABLE HELPERS
// =============================================================================

/**
 * Convert nullable to Effect
 */
export const fromNullable = <A>(
  value: A | null | undefined,
  onNull: () => SchedulingError
): SchedulingResult<A> =>
  value != null ? Effect.succeed(value) : Effect.fail(onNull());

/**
 * Convert Option-like (nullable) to Effect with error for null
 */
export const fromOption = <A>(
  onNone: () => SchedulingError
) => (value: A | null | undefined): SchedulingResult<A> =>
  fromNullable(value, onNone);

// =============================================================================
// SEQUENCING HELPERS
// =============================================================================

/**
 * Run effects in sequence, stopping on first error
 */
export const sequenceResults = <A>(
  effects: SchedulingResult<A>[]
): SchedulingResult<A[]> =>
  Effect.all(effects, { concurrency: 1 });

/**
 * Run effects in parallel, collecting all results or first error
 */
export const parallelResults = <A>(
  effects: SchedulingResult<A>[]
): SchedulingResult<A[]> =>
  Effect.all(effects, { concurrency: 'unbounded' });

// =============================================================================
// ERROR RECOVERY
// =============================================================================

/**
 * Provide fallback value on specific error
 */
export const recoverWith = <A>(
  predicate: (error: SchedulingError) => boolean,
  fallback: A
) => (effect: SchedulingResult<A>): SchedulingResult<A> =>
  pipe(
    effect,
    Effect.catch((error) =>
      predicate(error) ? Effect.succeed(fallback) : Effect.fail(error)
    )
  );

/**
 * Map specific errors to different errors
 */
export const mapError = (
  fn: (error: SchedulingError) => SchedulingError
) => <A>(effect: SchedulingResult<A>): SchedulingResult<A> =>
  Effect.mapError(effect, fn);

// =============================================================================
// IDEMPOTENCY
// =============================================================================

export interface IdempotencyStore {
  get: (key: string) => Promise<unknown | null>;
  set: (key: string, value: unknown, ttlSeconds: number) => Promise<void>;
}

/**
 * Make an operation idempotent using a key-value store
 */
export const withIdempotency = <A>(
  store: IdempotencyStore,
  key: string,
  ttlSeconds: number = 86400 // 24 hours
) => (effect: SchedulingResult<A>): SchedulingResult<A> =>
  Effect.gen(function* () {
    const existing = yield* fromPromise(
      () => store.get(key),
      (e) => Errors.infrastructure('REDIS', `Failed to check idempotency: ${e}`)
    );

    if (existing !== null) {
      return yield* Effect.fail(Errors.idempotency(key, existing));
    }

    const result = yield* effect;

    yield* fromPromise(
      () => store.set(key, result, ttlSeconds),
      (e) => Errors.infrastructure('REDIS', `Failed to store idempotency: ${e}`)
    );

    return result;
  });

// =============================================================================
// UUID GENERATION
// =============================================================================

export const generateId = (): string => crypto.randomUUID();

export const generateIdempotencyKey = (prefix: string = 'idem'): string =>
  `${prefix}_${generateId()}`;
