/**
 * Homegrown Adapter Concurrency Integration Test (real Postgres)
 * ----------------------------------------------------------------------------
 * Proves the write-time double-booking gate (TIN-2764) closes the race against
 * a real Postgres, not just the mock DB. Two concurrent createBooking calls for
 * the same practitioner + slot (distinct idempotency keys, so the idempotency
 * unique index is NOT what arbitrates) must resolve to exactly one booking; the
 * loser gets a ReservationError(SLOT_TAKEN).
 *
 * The mechanism under test is the practitioner-day transaction-scoped advisory
 * lock (pg_advisory_xact_lock) taken inside config.withTransaction: the first
 * writer holds the lock, inserts, and commits; the second blocks on the same
 * lock key, then its re-validation sees the committed booking and refuses. A
 * plain validate-then-insert under READ COMMITTED would let both inserts
 * through, so this test FAILS against pre-fix code (which does no write-time
 * validation). Day granularity (not exact slot start) is load-bearing: the
 * overlapping-writers test below proves two writers with different start times
 * but overlapping intervals contend on the same lock.
 *
 * Also covers the checkout pipeline regression (TIN-2764 blocker): a booking
 * completing a checkout must not be failed by the caller's OWN Phase B soft
 * hold, or every alt-payment booking dies with SLOT_TAKEN after charging.
 *
 * Env-gated: skips cleanly with no DATABASE_URL / PG_INTEGRATION. When it runs
 * it bootstraps its own tables (kit_* prefix) mirroring the homegrown adapter's
 * Drizzle schema, so no external migration is required.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Cause, Effect, Option } from 'effect';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import {
  pgTable,
  text,
  integer,
  boolean,
  jsonb,
  uuid,
} from 'drizzle-orm/pg-core';
import pg from 'pg';

import { createHomegrownAdapter } from '../../src/adapters/homegrown.js';
import type { BookingRequest } from '../../src/core/types.js';
import {
  completeBookingWithAltPayment,
  type PipelineContext,
} from '../../src/core/pipelines.js';
import { createManualPaymentAdapter } from '../../src/payments/manual.js';
import type { PaymentAdapter } from '../../src/payments/types.js';

// ---------------------------------------------------------------------------
// Env gate
// ---------------------------------------------------------------------------

const shouldRun = Boolean(process.env.DATABASE_URL || process.env.PG_INTEGRATION);
const connectionString =
  process.env.DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5432/scheduling_kit_test';

// vitest: describe.skip when the DB is not configured, so the suite is a clean
// no-op locally and in the shared CI lane, and only executes in the dedicated
// postgres-service job.
const suite = shouldRun ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Drizzle schema mirror (kit_* tables): the subset the adapter reads/writes.
// datetime-ish columns are text: the adapter reads/writes ISO-8601 UTC strings
// (`.toISOString()`), and fixed-format ...Z strings compare chronologically.
// ---------------------------------------------------------------------------

const services = pgTable('kit_services', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  description: text('description'),
  durationMinutes: integer('duration_minutes').notNull(),
  priceCents: integer('price_cents').notNull(),
  currency: text('currency').notNull().default('USD'),
  category: text('category'),
  active: boolean('active').notNull().default(true),
  displayOrder: integer('display_order').notNull().default(0),
  acuityId: text('acuity_id'),
});

const practitioners = pgTable('kit_practitioners', {
  id: uuid('id').primaryKey().defaultRandom(),
  handle: text('handle').notNull().unique(),
  name: text('name').notNull(),
  title: text('title'),
  photoUrl: text('photo_url'),
});

const businessHours = pgTable('kit_business_hours', {
  id: uuid('id').primaryKey().defaultRandom(),
  dayOfWeek: integer('day_of_week').notNull(),
  opens: text('opens').notNull(),
  closes: text('closes').notNull(),
});

const businessHoursOverrides = pgTable('kit_business_hours_overrides', {
  id: uuid('id').primaryKey().defaultRandom(),
  date: text('date').notNull(),
  opens: text('opens'),
  closes: text('closes'),
});

const clients = pgTable('kit_clients', {
  id: uuid('id').primaryKey().defaultRandom(),
  firstName: text('first_name').notNull(),
  lastName: text('last_name').notNull(),
  email: text('email').notNull().unique(),
  phone: text('phone'),
  notes: text('notes'),
  customFields: jsonb('custom_fields').notNull().default({}),
  createdAt: text('created_at'),
  updatedAt: text('updated_at'),
});

const bookings = pgTable('kit_bookings', {
  id: uuid('id').primaryKey().defaultRandom(),
  confirmationCode: text('confirmation_code'),
  serviceId: uuid('service_id'),
  practitionerId: uuid('practitioner_id'),
  clientId: uuid('client_id'),
  datetime: text('datetime').notNull(),
  endTime: text('end_time').notNull(),
  duration: integer('duration').notNull(),
  status: text('status').notNull(),
  paymentStatus: text('payment_status').notNull(),
  paymentMethod: text('payment_method'),
  amountCents: integer('amount_cents'),
  paymentRef: text('payment_ref'),
  idempotencyKey: text('idempotency_key').unique(),
  createdAt: text('created_at'),
  cancelledAt: text('cancelled_at'),
  cancelReason: text('cancel_reason'),
  updatedAt: text('updated_at'),
});

const timeBlocks = pgTable('kit_time_blocks', {
  id: uuid('id').primaryKey().defaultRandom(),
  startTime: text('start_time').notNull(),
  endTime: text('end_time').notNull(),
});

const slotReservations = pgTable('kit_slot_reservations', {
  id: uuid('id').primaryKey().defaultRandom(),
  datetime: text('datetime').notNull(),
  duration: integer('duration').notNull(),
  expiresAt: text('expires_at').notNull(),
  releasedAt: text('released_at'),
});

const schemas = {
  content: { services, practitioners, businessHours },
  booking: {
    bookings,
    timeBlocks,
    slotReservations,
    clients,
    businessHoursOverrides,
  },
};

// ---------------------------------------------------------------------------
// Bootstrap DDL: mirrors the schema above.
// ---------------------------------------------------------------------------

const DDL = sql`
  CREATE TABLE IF NOT EXISTS kit_services (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    description text,
    duration_minutes integer NOT NULL,
    price_cents integer NOT NULL,
    currency text NOT NULL DEFAULT 'USD',
    category text,
    active boolean NOT NULL DEFAULT true,
    display_order integer NOT NULL DEFAULT 0,
    acuity_id text
  );
  CREATE TABLE IF NOT EXISTS kit_practitioners (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    handle text NOT NULL UNIQUE,
    name text NOT NULL,
    title text,
    photo_url text
  );
  CREATE TABLE IF NOT EXISTS kit_business_hours (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    day_of_week integer NOT NULL,
    opens text NOT NULL,
    closes text NOT NULL
  );
  CREATE TABLE IF NOT EXISTS kit_business_hours_overrides (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    date text NOT NULL,
    opens text,
    closes text
  );
  CREATE TABLE IF NOT EXISTS kit_clients (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    first_name text NOT NULL,
    last_name text NOT NULL,
    email text NOT NULL UNIQUE,
    phone text,
    notes text,
    custom_fields jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at text,
    updated_at text
  );
  CREATE TABLE IF NOT EXISTS kit_bookings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    confirmation_code text,
    service_id uuid,
    practitioner_id uuid,
    client_id uuid,
    datetime text NOT NULL,
    end_time text NOT NULL,
    duration integer NOT NULL,
    status text NOT NULL,
    payment_status text NOT NULL,
    payment_method text,
    amount_cents integer,
    payment_ref text,
    idempotency_key text UNIQUE,
    created_at text DEFAULT (now()::text),
    cancelled_at text,
    cancel_reason text,
    updated_at text
  );
  CREATE TABLE IF NOT EXISTS kit_time_blocks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    start_time text NOT NULL,
    end_time text NOT NULL
  );
  CREATE TABLE IF NOT EXISTS kit_slot_reservations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    datetime text NOT NULL,
    duration integer NOT NULL,
    expires_at text NOT NULL,
    released_at text
  );
`;

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

suite('HomegrownAdapter concurrency against real Postgres', () => {
  let pool: pg.Pool;
  let db: ReturnType<typeof drizzle>;
  let serviceId: string;
  let serviceId120: string;

  const SLOT = '2026-04-20T14:00:00.000Z';
  // Far-future fixed Monday 10:00 America/New_York (14:00Z in EDT), so the
  // pipeline's business-hours + min-advance checks pass deterministically.
  const PIPELINE_SLOT = '2099-04-20T14:00:00.000Z';
  // Starts 60 min into PIPELINE_SLOT's 120-min interval: overlapping but a
  // DIFFERENT start time, so exact-start lock keys would not contend.
  const OVERLAP_SLOT = '2099-04-20T15:00:00.000Z';
  const HANDLE = 'alex';

  const buildAdapter = () =>
    createHomegrownAdapter({
      schemas,
      defaultPractitionerHandle: HANDLE,
      getDb: async () => db,
      // Real transaction runner: the write path takes its practitioner-day
      // advisory lock and re-validates inside this transaction.
      withTransaction: (fn) => db.transaction(fn),
    });

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString, max: 10 });
    db = drizzle(pool);
    await db.execute(DDL);
    // Seed services (60-min and 120-min) and the default practitioner.
    await db.execute(sql`
      INSERT INTO kit_services (name, duration_minutes, price_cents, currency, active, display_order, acuity_id)
      VALUES ('Deep Tissue Massage', 60, 9500, 'USD', true, 1, 'svc-massage-60')
      ON CONFLICT DO NOTHING;
    `);
    await db.execute(sql`
      INSERT INTO kit_services (name, duration_minutes, price_cents, currency, active, display_order, acuity_id)
      VALUES ('Hot Stone Massage', 120, 18000, 'USD', true, 2, 'svc-massage-120')
      ON CONFLICT DO NOTHING;
    `);
    await db.execute(sql`
      INSERT INTO kit_practitioners (handle, name, title)
      VALUES (${HANDLE}, 'Alex Rivera', 'Licensed Massage Therapist')
      ON CONFLICT (handle) DO NOTHING;
    `);
    // Business hours for every day of the week: the checkout pipeline's
    // Phase A availability check requires effective hours (createBooking
    // itself does not, so the direct-adapter tests never needed these).
    await db.execute(sql`DELETE FROM kit_business_hours;`);
    for (let dayOfWeek = 0; dayOfWeek < 7; dayOfWeek++) {
      await db.execute(sql`
        INSERT INTO kit_business_hours (day_of_week, opens, closes)
        VALUES (${dayOfWeek}, '09:00', '17:00');
      `);
    }
    const [svc60] = await db
      .select({ id: services.id })
      .from(services)
      .where(sql`${services.acuityId} = 'svc-massage-60'`)
      .limit(1);
    serviceId = svc60.id;
    const [svc120] = await db
      .select({ id: services.id })
      .from(services)
      .where(sql`${services.acuityId} = 'svc-massage-120'`)
      .limit(1);
    serviceId120 = svc120.id;
  }, 30000);

  afterAll(async () => {
    if (pool) {
      await pool.query(
        'DROP TABLE IF EXISTS kit_bookings, kit_clients, kit_slot_reservations, kit_time_blocks, kit_business_hours_overrides, kit_business_hours, kit_practitioners, kit_services CASCADE;',
      );
      await pool.end();
    }
  });

  beforeEach(async () => {
    // Clean bookings and holds between tests; reseed the shared client so the
    // outside-txn findOrCreateClient hits the update path (no client-insert
    // unique race).
    await db.execute(sql`DELETE FROM kit_bookings;`);
    await db.execute(sql`DELETE FROM kit_slot_reservations;`);
    await db.execute(sql`DELETE FROM kit_clients;`);
    await db.execute(sql`
      INSERT INTO kit_clients (first_name, last_name, email, phone)
      VALUES ('Alice', 'Smith', 'alice@example.com', '607-555-1234');
    `);
  });

  const request = (idempotencyKey: string): BookingRequest => ({
    serviceId,
    datetime: SLOT,
    client: {
      firstName: 'Alice',
      lastName: 'Smith',
      email: 'alice@example.com',
      phone: '607-555-1234',
    },
    idempotencyKey,
  });

  const requestFor = (
    idempotencyKey: string,
    overrides: Partial<Pick<BookingRequest, 'serviceId' | 'datetime'>>,
  ): BookingRequest => ({ ...request(idempotencyKey), ...overrides });

  it('lets exactly one of two concurrent bookings for the same slot win', async () => {
    const adapter = buildAdapter();

    // Distinct idempotency keys: the idempotency index cannot be what
    // arbitrates, so the slot advisory lock + re-validation must.
    const results = await Promise.allSettled([
      Effect.runPromise(adapter.createBooking(request('race-A'))),
      Effect.runPromise(adapter.createBooking(request('race-B'))),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    // Exactly one write won.
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // And the database holds exactly one booking for the slot.
    const rows = await db
      .select({ id: bookings.id })
      .from(bookings)
      .where(sql`${bookings.datetime} = ${SLOT}`);
    expect(rows).toHaveLength(1);
  }, 30000);

  it('rejects a second sequential booking for a slot already taken', async () => {
    const adapter = buildAdapter();

    const first = await Effect.runPromise(adapter.createBooking(request('seq-1')));
    expect(first.datetime).toBe(SLOT);

    const outcome = await Effect.runPromiseExit(
      adapter.createBooking(request('seq-2')),
    );
    expect(outcome._tag).toBe('Failure');

    const rows = await db
      .select({ id: bookings.id })
      .from(bookings)
      .where(sql`${bookings.datetime} = ${SLOT}`);
    expect(rows).toHaveLength(1);
  }, 30000);

  it('lets exactly one of two concurrent soft holds for the same slot win before payment', async () => {
    const adapter = buildAdapter();
    const hold = () =>
      adapter.softHoldSlot({
        serviceId,
        datetime: PIPELINE_SLOT,
        duration: 60,
      });

    const exits = await Promise.all([
      Effect.runPromiseExit(hold()),
      Effect.runPromiseExit(hold()),
    ]);

    expect(exits.filter((exit) => exit._tag === 'Success')).toHaveLength(1);
    const failures = exits.filter((exit) => exit._tag === 'Failure');
    expect(failures).toHaveLength(1);
    const failure = Cause.findErrorOption(failures[0].cause);
    expect(Option.isSome(failure)).toBe(true);
    expect(Option.getOrThrow(failure)).toMatchObject({
      _tag: 'ReservationError',
      code: 'SLOT_TAKEN',
    });

    const rows = await db
      .select({ id: slotReservations.id })
      .from(slotReservations)
      .where(sql`${slotReservations.datetime} = ${PIPELINE_SLOT}`);
    expect(rows).toHaveLength(1);
  }, 30000);

  // TIN-2764 regression (revenue path): the checkout pipeline places its own
  // advisory soft hold in Phase B, charges in Phase C, and creates the booking
  // in Phase D. Pre-fix, Phase D's write-time gate counted the caller's OWN
  // hold as a conflict, so every held alt-payment booking failed with
  // SLOT_TAKEN after the customer was charged and fell into the refund path.
  it('completes an alt-payment checkout whose own soft hold is active at booking time', async () => {
    const payments = new Map<string, PaymentAdapter>([
      [
        'cash',
        createManualPaymentAdapter({ type: 'manual', methods: ['cash'] }, 'cash'),
      ],
    ]);
    const ctx: PipelineContext = {
      scheduler: buildAdapter(),
      payments,
      correlationId: 'itest-hold',
    };

    const result = await Effect.runPromise(
      completeBookingWithAltPayment(ctx, {
        request: requestFor('pipeline-hold-1', { datetime: PIPELINE_SLOT }),
        paymentMethod: 'cash',
      }),
    );

    // The hold must exist for this test to exercise the defect: Phase B
    // degrades to no-hold on softHoldSlot failure (Effect.catchAll), and a
    // hold-less run would pass even against pre-fix code.
    expect(result.softHold).toBeDefined();
    expect(result.booking.datetime).toBe(PIPELINE_SLOT);

    // Exactly one booking row landed.
    const rows = await db
      .select({ id: bookings.id })
      .from(bookings)
      .where(sql`${bookings.datetime} = ${PIPELINE_SLOT}`);
    expect(rows).toHaveLength(1);

    // Phase E released the hold after the successful booking.
    const [hold] = await db
      .select({ releasedAt: slotReservations.releasedAt })
      .from(slotReservations)
      .where(sql`${slotReservations.id} = ${result.softHold!.id}`);
    expect(hold.releasedAt).not.toBeNull();
  }, 30000);

  // TIN-2764 regression (overlapping-slot race): two writers for the same
  // practitioner with DIFFERENT start times but OVERLAPPING intervals must
  // contend on the same lock. Pre-fix the advisory lock key hashed the exact
  // slot start, so a 120-min booking at 14:00Z and a 60-min booking at 15:00Z
  // took different locks and both passed the open-check: double-booking.
  //
  // The interleaving is encoded deterministically rather than left to the
  // scheduler: writer A's harness-owned withTransaction signals once A's
  // critical section (lock + check + insert) has run, then parks the still
  // OPEN transaction on a gate. Writer B then runs against a plain adapter
  // while A is provably uncommitted. The 1.5s bounded wait lets B either
  // settle (pre-fix: it commits a double-booking) or block on A's lock
  // (post-fix); the post-fix assertions are interleaving-agnostic, so the
  // bounded wait cannot flake the shipped test.
  it('lets exactly one of two overlapping bookings with different start times win', async () => {
    const deferred = () => {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      return { promise, resolve };
    };
    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

    const aInside = deferred();
    const releaseGate = deferred();

    // Writer A: 120-min service at 14:00Z, transaction held open on the gate
    // after its critical section so B demonstrably runs before A commits.
    const gatedAdapter = createHomegrownAdapter({
      schemas,
      defaultPractitionerHandle: HANDLE,
      getDb: async () => db,
      withTransaction: (fn) =>
        db.transaction(async (tx) => {
          const r = await fn(tx);
          aInside.resolve();
          await releaseGate.promise;
          return r;
        }),
    });
    // Writer B: plain adapter, 60-min service at 15:00Z, entirely inside A's
    // [14:00Z, 16:00Z) interval.
    const plainAdapter = buildAdapter();

    let aExit;
    let bExit;
    try {
      const aPromise = Effect.runPromiseExit(
        gatedAdapter.createBooking(
          requestFor('overlap-A', {
            serviceId: serviceId120,
            datetime: PIPELINE_SLOT,
          }),
        ),
      );
      await aInside.promise;

      const bPromise = Effect.runPromiseExit(
        plainAdapter.createBooking(
          requestFor('overlap-B', { datetime: OVERLAP_SLOT }),
        ),
      );
      // Bounded wait: pre-fix B settles immediately (wrong lock key, no
      // contention); post-fix B blocks on the shared practitioner-day lock
      // until A commits, so the delay elapses instead.
      await Promise.race([bPromise, delay(1500)]);

      releaseGate.resolve();
      [aExit, bExit] = await Promise.all([aPromise, bPromise]);
    } finally {
      // A failed assertion or throw above must not leave A's transaction
      // open, or afterAll's pool.end() hangs the suite.
      releaseGate.resolve();
    }

    const exits = [aExit, bExit];
    expect(exits.filter((e) => e!._tag === 'Success')).toHaveLength(1);
    expect(exits.filter((e) => e!._tag === 'Failure')).toHaveLength(1);

    // Exactly one booking row overlaps [14:00Z, 16:00Z).
    const rows = await db
      .select({ id: bookings.id })
      .from(bookings)
      .where(
        sql`${bookings.datetime} < '2099-04-20T16:00:00.000Z' AND ${bookings.endTime} > '2099-04-20T14:00:00.000Z'`,
      );
    expect(rows).toHaveLength(1);
  }, 30000);
});
