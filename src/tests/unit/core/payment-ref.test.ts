/**
 * Tests for core/payment-ref.ts
 *
 * The wire format `[PROCESSOR] Transaction: <id>` is deployed in production
 * bookings (Acuity notes fields). These tests pin:
 * 1. byte-identical encoding vs. the legacy string template
 * 2. parse compatibility with every string the legacy pipeline regexes
 *    (`/\[(\w+)\]/`, `/Transaction:\s*(\S+)/`) could extract
 * 3. the property `parse(format(x)) deepEquals x` over the canonical domain
 * 4. typed ValidationError failures instead of silent undefined halves
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { Cause, Effect, Exit, Option } from 'effect';
import {
  formatPaymentRef,
  parsePaymentRef,
  type PaymentReference,
} from '../../../core/payment-ref.js';
import type { SchedulingError, ValidationError } from '../../../core/types.js';

// =============================================================================
// SYNC HELPERS
// =============================================================================

const parseOk = (raw: string): PaymentReference => Effect.runSync(parsePaymentRef(raw));

const parseErr = (raw: string | undefined | null): ValidationError => {
  const exit = Effect.runSyncExit(parsePaymentRef(raw));
  if (Exit.isSuccess(exit)) {
    throw new Error(`Expected parse failure for: ${String(raw)}`);
  }
  const failure = Cause.findErrorOption(exit.cause);
  if (Option.isNone(failure)) {
    throw new Error('Expected a typed failure, got a defect');
  }
  const error: SchedulingError = failure.value;
  expect(error._tag).toBe('ValidationError');
  return error as ValidationError;
};

// =============================================================================
// CANONICAL DOMAIN ARBITRARIES
// =============================================================================

/** Canonical processor: lowercase word characters, as adapter names are keyed. */
const processorArb = fc.stringMatching(/^[a-z0-9_]+$/);

/** Transaction id: any non-empty run of printable, non-space ASCII. */
const transactionIdArb = fc.stringMatching(/^[\x21-\x7e]+$/);

const paymentReferenceArb: fc.Arbitrary<PaymentReference> = fc.record({
  processor: processorArb,
  transactionId: transactionIdArb,
});

// =============================================================================
// FORMAT
// =============================================================================

describe('formatPaymentRef', () => {
  it('is byte-identical to the legacy production template', () => {
    expect(formatPaymentRef({ processor: 'cash', transactionId: 'cash_100001' })).toBe(
      '[CASH] Transaction: cash_100001'
    );
    expect(formatPaymentRef({ processor: 'stripe', transactionId: 'pi_3MtwBw' })).toBe(
      '[STRIPE] Transaction: pi_3MtwBw'
    );
  });

  it('matches the legacy template for arbitrary inputs', () => {
    fc.assert(
      fc.property(paymentReferenceArb, (ref) => {
        const legacy = `[${ref.processor.toUpperCase()}] Transaction: ${ref.transactionId}`;
        expect(formatPaymentRef(ref)).toBe(legacy);
      })
    );
  });
});

// =============================================================================
// ROUND TRIP
// =============================================================================

describe('round trip', () => {
  it('parse(format(x)) deep-equals x over the canonical domain', () => {
    fc.assert(
      fc.property(paymentReferenceArb, (ref) => {
        expect(parseOk(formatPaymentRef(ref))).toEqual(ref);
      })
    );
  });

  it('round-trips when embedded in surrounding note text', () => {
    // Acuity prepends client notes (and other tooling appends annotations);
    // the marker must survive embedding. Prefix is bracket-free prose.
    const proseArb = fc.stringMatching(/^[a-zA-Z0-9 .,]*$/);
    fc.assert(
      fc.property(paymentReferenceArb, proseArb, (ref, notes) => {
        const stored = notes ? `${notes}\n\n${formatPaymentRef(ref)}` : formatPaymentRef(ref);
        expect(parseOk(stored)).toEqual(ref);
      })
    );
  });
});

// =============================================================================
// LEGACY STORED-STRING FIXTURES
// =============================================================================

describe('parsePaymentRef — legacy stored strings', () => {
  it('parses the plain production format', () => {
    expect(parseOk('[CASH] Transaction: cash_100001')).toEqual({
      processor: 'cash',
      transactionId: 'cash_100001',
    });
  });

  it('parses a ref with a trailing refund annotation (first marker wins)', () => {
    expect(parseOk('[ZELLE] Transaction: zelle_100003 [REFUND] refund_100003')).toEqual({
      processor: 'zelle',
      transactionId: 'zelle_100003',
    });
  });

  it('parses an Acuity notes field with client notes after the marker', () => {
    expect(parseOk('[CASH] Transaction: cash_100001\nNew patient, referred by Dr. Smith')).toEqual({
      processor: 'cash',
      transactionId: 'cash_100001',
    });
  });

  it('parses an Acuity notes field with client notes before the marker', () => {
    expect(parseOk('Prefers afternoons\n\n[VENMO] Transaction: venmo_100004')).toEqual({
      processor: 'venmo',
      transactionId: 'venmo_100004',
    });
  });

  it('lowercases the processor token like the legacy parser', () => {
    expect(parseOk('[stripe] Transaction: pi_123')).toEqual({
      processor: 'stripe',
      transactionId: 'pi_123',
    });
  });

  it('accepts zero whitespace after Transaction: (legacy \\s*)', () => {
    expect(parseOk('[CASH]Transaction:cash_1')).toEqual({
      processor: 'cash',
      transactionId: 'cash_1',
    });
  });

  it('falls back to independent legacy scans when the marker is split', () => {
    // Legacy behavior: first [token] + first 'Transaction: id' anywhere.
    expect(parseOk('[CASH] paid in person, Transaction: cash_9')).toEqual({
      processor: 'cash',
      transactionId: 'cash_9',
    });
  });

  it('prefers the intact canonical marker over a stray earlier bracket token', () => {
    // The legacy regexes would have resolved processor 'vip' here and the
    // refund would have been silently skipped. The codec finds the marker.
    expect(parseOk('Client note [VIP]\n\n[CASH] Transaction: cash_77777')).toEqual({
      processor: 'cash',
      transactionId: 'cash_77777',
    });
  });

  it('prefers the canonical marker transaction id over stray earlier Transaction: text', () => {
    // Canonical-first changes the transactionId half too, not just the
    // processor: the legacy independent scans took the FIRST
    // 'Transaction: <tok>' anywhere, so this string resolved
    // {cash, tx_early} — a refund aimed at the wrong transaction. The codec
    // takes the id bound to the intact marker.
    expect(
      parseOk('Client says Transaction: tx_early was declined\n\n[CASH] Transaction: tx_late')
    ).toEqual({
      processor: 'cash',
      transactionId: 'tx_late',
    });
  });

  it('prefers a later intact marker over an earlier split marker (both halves change)', () => {
    // Full extent of the canonical-first deviation: the legacy scans
    // resolved {cash, cash_9} here; the codec resolves the intact later
    // marker, changing BOTH the processor and the transaction id. No
    // production writer emits split markers, so this shape is contrived,
    // but the preference is pinned deliberately.
    expect(parseOk('[CASH] paid, Transaction: cash_9\n\n[STRIPE] Transaction: pi_1')).toEqual({
      processor: 'stripe',
      transactionId: 'pi_1',
    });
  });
});

// =============================================================================
// TYPED FAILURES
// =============================================================================

describe('parsePaymentRef — typed failures', () => {
  it('fails on empty, undefined, and null input', () => {
    for (const raw of ['', undefined, null] as const) {
      const error = parseErr(raw);
      expect(error.field).toBe('paymentRef');
    }
  });

  it('fails when the transaction id is missing', () => {
    const error = parseErr('[CASH] No transaction here');
    expect(error.field).toBe('paymentRef');
    expect(error.message).toContain('no transaction id');
    expect(error.value).toBe('[CASH] No transaction here');
  });

  it('fails when the processor marker is missing', () => {
    const error = parseErr('Transaction: tx_1 with no processor');
    expect(error.message).toContain('no [PROCESSOR] marker');
  });

  it('fails on a raw transaction id with no wire formatting', () => {
    const error = parseErr('pi_3MtwBwLkdIwHu7ix28a3tqPa');
    expect(error.field).toBe('paymentRef');
    expect(error.value).toBe('pi_3MtwBwLkdIwHu7ix28a3tqPa');
  });

  it('fails on hyphenated processor tokens (outside the \\w+ wire grammar)', () => {
    // '[VENMO-DIRECT]' was never parseable by the legacy regexes either —
    // the codec keeps that grammar but makes the failure loud and typed.
    const error = parseErr('[VENMO-DIRECT] Transaction: tx_1');
    expect(error.message).toContain('no [PROCESSOR] marker');
  });
});
