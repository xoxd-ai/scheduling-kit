/**
 * Homegrown Scheduling Adapter
 *
 * Direct PG-backed scheduling — replaces Acuity browser automation.
 * Implements the full SchedulingAdapter interface (17 methods) using
 * Drizzle ORM queries against Neon PostgreSQL.
 *
 * Feature-flagged: only active when SCHEDULING_BACKEND=homegrown
 */

import { Effect } from "effect";

import type { SchedulingAdapter } from "./types.js";
import type {
  Service,
  Provider,
  TimeSlot,
  AvailableDate,
  Booking,
  BookingRequest,
  SlotSoftHold,
  ClientInfo,
  SchedulingResult,
  SchedulingError,
  BookingStatus,
  PaymentStatus,
} from "../core/types.js";
import { Errors } from "../core/types.js";
import {
  getAvailableSlots as computeSlots,
  isSlotAvailable,
  hasOverlap,
  getDatesWithAvailability,
  generateConfirmationCode,
  occupiedDayBoundsUtc,
  toDateString,
  type HoursWindow,
  type HoursOverride,
  type OccupiedBlock,
  type SlotConfig,
} from "./availability-engine.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface HomegrownContentSchemaTables {
  services: any;
  practitioners: any;
  businessHours: any;
}

export interface HomegrownBookingSchemaTables {
  bookings: any;
  timeBlocks: any;
  slotReservations: any;
  clients: any;
  businessHoursOverrides: any;
}

export interface HomegrownAdapterSchemas {
  content: HomegrownContentSchemaTables;
  booking: HomegrownBookingSchemaTables;
}

export type HomegrownAdapterSchemaProvider =
  | HomegrownAdapterSchemas
  | (() => Promise<HomegrownAdapterSchemas>);

export interface HomegrownAdapterConfig {
  /**
   * Trusted server-configured UUID written to new clients, bookings, and holds.
   * Never derive this from BookingRequest or other untrusted input. The consumer
   * must bind the same identity to withDb/withTransaction and restricted-role RLS;
   * this value does not scope reads, install policies, or establish isolation.
   * Omission preserves existing consumer-owned insert/default behavior.
   */
  tenantId?: string;
  /** Drizzle database instance (lazy, to avoid import-time DB connection). */
  getDb?: () => Promise<any>;
  /**
   * Optional scoped database executor.
   *
   * Consumers with transaction-local RLS, tenant pinning, or connection
   * middleware should provide this instead of exposing a raw database handle.
   * The callback receives a Drizzle database/transaction object and the adapter
   * awaits the callback result before leaving the scope.
   */
  withDb?: <T>(fn: (db: any) => Promise<T>) => Promise<T>;
  /**
   * Optional transaction runner for the slot-validating write paths.
   *
   * When provided, softHoldSlot, createBooking, and rescheduleBooking run their
   * read-validate-write critical section inside this callback so the
   * availability re-check and the insert/update are one atomic unit, and a
   * practitioner-day Postgres advisory lock (pg_advisory_xact_lock) can
   * serialize concurrent writers for the same practitioner + local calendar
   * day, including writers targeting overlapping but different start times.
   * This also makes soft-hold acquisition a pre-payment admission gate: two
   * checkouts cannot both acquire a hold for one slot. Supply
   * `(fn) => db.transaction(fn)`.
   *
   * When omitted, those paths fall back to withDb and the atomicity of the
   * critical section then depends entirely on the semantics of the consumer's
   * withDb: a bare passthrough gives none, so two concurrent checkouts can both
   * acquire holds and two concurrent writers can still double-book the same
   * slot. Provide withTransaction in production Postgres deployments; the
   * concurrency integration tests only close these races with it.
   *
   * Scope of the additive change: supplying withTransaction is additive for the
   * advisory lock only. Omitting it disables the lock (concurrent writers are no
   * longer serialized), but it does NOT restore the previous method contract.
   * The write-time slot re-validation (assertSlotOpen) runs on every path,
   * transactional or not, so relative to the pre-validation behavior:
   * createBooking can now reject with ReservationError(SLOT_TAKEN) when the slot
   * is taken, and rescheduleBooking can now reject with the same SLOT_TAKEN for
   * an overlapping target or ValidationError(status) for a cancelled/completed
   * booking. Callers (including bare withDb consumers) must handle these typed
   * failures on inputs that previously succeeded.
   */
  withTransaction?: <T>(fn: (tx: any) => Promise<T>) => Promise<T>;
  /**
   * Drizzle table modules used by the homegrown scheduling backend.
   *
   * Pass this to keep scheduling-kit independent from any specific schema
   * package. If omitted, the adapter falls back to the legacy
   * @tummycrypt/tinyland-auth-pg schema exports for existing adopters.
   */
  schemas?: HomegrownAdapterSchemaProvider;
  /** Timezone for availability calculations */
  timezone?: string;
  /** Slot interval in minutes */
  slotInterval?: number;
  /** Buffer between appointments in minutes */
  bufferMinutes?: number;
  /** Minimum advance booking hours */
  minAdvanceHours?: number;
  /**
   * Default practitioner handle (solo practice).
   *
   * There is no built-in fallback: operations that resolve the default
   * practitioner (getProviders, getProvidersForService, createBooking) fail
   * with a typed ValidationError when this is not configured.
   */
  defaultPractitionerHandle?: string;
  /**
   * Prefix for generated booking confirmation codes (e.g. "BK" → "BK-X7K2P9").
   * Defaults to the neutral "BK". Adopters with established prefixes must set
   * this explicitly (consumer-visible change for upgraders).
   */
  confirmationCodePrefix?: string;
}

// ---------------------------------------------------------------------------
// Internal typed-error carrier
// ---------------------------------------------------------------------------

/**
 * Internal carrier that smuggles a typed SchedulingError through async
 * throw/catch boundaries so `fromAsync` can surface it as-is instead of
 * collapsing every failure to InfrastructureError("UNKNOWN").
 */
class DomainErrorCarrier extends Error {
  readonly schedulingError: SchedulingError;

  constructor(schedulingError: SchedulingError) {
    super(
      "message" in schedulingError
        ? schedulingError.message
        : schedulingError._tag,
    );
    this.name = "DomainErrorCarrier";
    this.schedulingError = schedulingError;
  }
}

/** Throw a typed domain failure (caught and unwrapped by fromAsync). */
const domainError = (error: SchedulingError): never => {
  throw new DomainErrorCarrier(error);
};

/**
 * Best-effort detection of a PostgreSQL unique-violation (SQLSTATE 23505).
 * Drivers differ in where they expose the code, so check error, error.cause,
 * and the message text.
 */
const isUniqueViolation = (e: unknown): boolean => {
  if (e === null || typeof e !== "object") return false;
  const err = e as { code?: unknown; cause?: unknown; message?: unknown };
  if (err.code === "23505") return true;
  const cause = err.cause as { code?: unknown } | undefined;
  if (cause && cause.code === "23505") return true;
  const message = typeof err.message === "string" ? err.message : "";
  return /duplicate key|unique constraint|unique violation/i.test(message);
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const createHomegrownAdapter = (
  config: HomegrownAdapterConfig,
): SchedulingAdapter => {
  if (!config.getDb && !config.withDb) {
    throw new Error("HomegrownAdapter requires either getDb or withDb");
  }
  const tenantId = config.tenantId;
  if (
    tenantId !== undefined &&
    (typeof tenantId !== "string" || !UUID_PATTERN.test(tenantId))
  ) {
    throw new Error("HomegrownAdapter tenantId must be a UUID when supplied");
  }
  // Capture the validated server binding once; later config/request mutations
  // cannot redirect an adapter instance's insert identity.
  const tenantValues = tenantId === undefined ? {} : { tenantId };

  const tz = config.timezone ?? "America/New_York";
  const interval = config.slotInterval ?? 30;
  const buffer = config.bufferMinutes ?? 0;
  const minAdvance = config.minAdvanceHours ?? 2;
  const practitionerHandle = config.defaultPractitionerHandle;
  const confirmationCodePrefix = config.confirmationCodePrefix;
  let legacySchemasPromise: Promise<HomegrownAdapterSchemas> | undefined;

  const withDb = async <T>(fn: (db: any) => Promise<T>): Promise<T> => {
    if (config.withDb) return config.withDb(fn);
    return fn(await config.getDb!());
  };

  // True when the consumer supplied a real transaction runner. Gates the
  // practitioner-day advisory lock: the lock is only meaningful (and only
  // issues a pg_advisory_xact_lock) inside an actual transaction, so the
  // withDb fallback path skips it.
  const transactional = !!config.withTransaction;

  /**
   * Run the write critical section inside a transaction when the consumer
   * provided one, otherwise fall back to withDb. See
   * HomegrownAdapterConfig.withTransaction for the atomicity contract.
   */
  const runInTransaction = async <T>(
    fn: (db: any) => Promise<T>,
  ): Promise<T> => {
    if (config.withTransaction) return config.withTransaction(fn);
    return withDb(fn);
  };

  // Advisory-lock namespace ("SC" = scheduling-kit) that partitions our locks
  // from any other pg_advisory_xact_lock users sharing the connection.
  const SLOT_LOCK_NAMESPACE = 0x5343;

  /** Advance a YYYY-MM-DD key by one calendar day without timezone drift. */
  const nextDayKey = (dayKey: string): string => {
    const date = new Date(`${dayKey}T00:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() + 1);
    return date.toISOString().slice(0, 10);
  };

  /**
   * Derive a signed 32-bit key (pg int4) for a resource + local day
   * (YYYY-MM-DD) via FNV-1a. Concurrent writers targeting the same
   * practitioner and local day hash to the same key and therefore serialize
   * on the same advisory lock. Day granularity (rather than exact slot start)
   * is what makes OVERLAPPING writes with different start times contend:
   * exact-start keys let a 10:00 and a 10:30 writer for the same practitioner
   * take different locks and double-book. The cost is serializing all
   * bookings for a practitioner-day, not just conflicting ones; acceptable
   * write-rate for this solo-practice domain.
   */
  const advisoryLockKey = (resource: string, dayKey: string): number => {
    const input = `${resource}|${dayKey}`;
    let h = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
      h ^= input.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h | 0;
  };

  /**
   * Take transaction-scoped advisory locks covering a candidate interval.
   * Auto-release on commit or rollback. Unlike SELECT ... FOR UPDATE this
   * also covers the "no conflicting row exists yet" case that a plain
   * validate-then-insert leaves open under READ COMMITTED.
   *
   * The lock span is the interval padded by the configured buffer so it
   * matches assertSlotOpen's padded conflict window, and one lock is taken
   * per local calendar day the padded interval touches (normally one, two
   * when a slot or its buffer crosses local midnight). Keys are taken in
   * sorted order so concurrent multi-day writers cannot deadlock.
   */
  const acquireSlotLocks = async (
    d: any,
    resource: string,
    startIso: string,
    endIso: string,
  ): Promise<void> => {
    const { sql } = await import("drizzle-orm");
    const bufferedStart = new Date(
      new Date(startIso).getTime() - buffer * 60_000,
    );
    const bufferedEnd = new Date(new Date(endIso).getTime() + buffer * 60_000);
    const firstDay = toDateString(bufferedStart.toISOString(), tz);
    const lastDay = toDateString(bufferedEnd.toISOString(), tz);
    // Walk calendar-day keys, not fixed 24-hour UTC jumps. A spring-forward
    // transition makes a local day 23 hours and can otherwise skip a date for
    // long services or buffers.
    for (let day = firstDay; day <= lastDay; day = nextDayKey(day)) {
      await d.execute(
        sql`select pg_advisory_xact_lock(${SLOT_LOCK_NAMESPACE}::int4, ${advisoryLockKey(
          resource,
          day,
        )}::int4)`,
      );
    }
  };

  const loadLegacyAuthPgSchemas =
    async (): Promise<HomegrownAdapterSchemas> => {
      const importOptional = (specifier: string): Promise<any> =>
        import(specifier);

      try {
        const [content, booking] = await Promise.all([
          importOptional("@tummycrypt/tinyland-auth-pg/content-schema"),
          importOptional("@tummycrypt/tinyland-auth-pg/booking-schema"),
        ]);

        return {
          content: {
            services: content.services,
            practitioners: content.practitioners,
            businessHours: content.businessHours,
          },
          booking: {
            bookings: booking.bookings,
            timeBlocks: booking.timeBlocks,
            slotReservations: booking.slotReservations,
            clients: booking.clients,
            businessHoursOverrides: booking.businessHoursOverrides,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `HomegrownAdapter could not load legacy @tummycrypt/tinyland-auth-pg schemas. Pass config.schemas to use a dedicated schema package. Cause: ${message}`,
        );
      }
    };

  const loadSchemas = async (): Promise<HomegrownAdapterSchemas> => {
    if (typeof config.schemas === "function") {
      return config.schemas();
    }
    if (config.schemas) {
      return config.schemas;
    }

    legacySchemasPromise ??= loadLegacyAuthPgSchemas();
    return legacySchemasPromise;
  };

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Wrap an async operation in Effect.
   *
   * Known domain failures thrown via `domainError` surface as their typed
   * SchedulingError variants; everything else stays mapped to
   * InfrastructureError("UNKNOWN").
   *
   * CAUTION: the carrier only survives plain async throw/catch boundaries.
   * Do NOT call `Effect.runPromise` on another adapter method inside an
   * `fromAsync` body expecting typed errors to propagate — a failed nested
   * run throws a FiberFailure, which is not a DomainErrorCarrier and will
   * collapse to InfrastructureError("UNKNOWN"). Compose Effects with
   * Effect.flatMap instead, or only nest runs whose error channel is empty.
   */
  const fromAsync = <A>(fn: () => Promise<A>): SchedulingResult<A> =>
    Effect.tryPromise({
      try: fn,
      catch: (e) => {
        if (e instanceof DomainErrorCarrier) return e.schedulingError;
        return Errors.infrastructure(
          "UNKNOWN",
          e instanceof Error ? e.message : "Unknown error",
          e instanceof Error ? e : undefined,
        );
      },
    });

  /** Resolve a service by UUID or acuityId */
  const resolveService = async (serviceId: string): Promise<any> => {
    const { services: servicesTable } = (await loadSchemas()).content;
    const { eq, or } = await import("drizzle-orm");

    // UUID regex — only compare against UUID column if input looks like one
    const isUuid = UUID_PATTERN.test(serviceId);

    const condition = isUuid
      ? or(
          eq(servicesTable.id, serviceId),
          eq(servicesTable.acuityId, serviceId),
        )
      : eq(servicesTable.acuityId, serviceId);

    return withDb(async (d) => {
      const [row] = await d
        .select()
        .from(servicesTable)
        .where(condition)
        .limit(1);

      return row ?? null;
    });
  };

  /** Load business hours as a Map<dayOfWeek, HoursWindow> */
  const loadHoursMap = async (): Promise<Map<number, HoursWindow>> => {
    const { businessHours } = (await loadSchemas()).content;
    const { asc } = await import("drizzle-orm");
    return withDb(async (d) => {
      const rows = await d
        .select()
        .from(businessHours)
        .orderBy(asc(businessHours.dayOfWeek));
      const map = new Map<number, HoursWindow>();
      for (const row of rows) {
        map.set(row.dayOfWeek, { opens: row.opens, closes: row.closes });
      }
      return map;
    });
  };

  /** Load overrides for a date range */
  const loadOverrides = async (
    startDate: string,
    endDate: string,
  ): Promise<HoursOverride[]> => {
    const { businessHoursOverrides } = (await loadSchemas()).booking;
    const { gte, lte, and } = await import("drizzle-orm");
    return withDb(async (d) => {
      const rows = await d
        .select()
        .from(businessHoursOverrides)
        .where(
          and(
            gte(businessHoursOverrides.date, startDate),
            lte(businessHoursOverrides.date, endDate),
          ),
        );
      return rows.map((r: any) => ({
        date: r.date,
        opens: r.opens,
        closes: r.closes,
      }));
    });
  };

  /**
   * Load occupied blocks (bookings + time_blocks + active reservations) for a
   * local-date range using the supplied executor.
   *
   * Shared by the read paths (via loadOccupied, which opens its own scope) and
   * the transactional write gate (assertSlotOpen), which must reuse the
   * transaction's executor rather than opening a new scope.
   *
   * The window is the tz-aware half-open interval [startIso, endExclusiveIso):
   * the old `${date}T00:00:00Z` / `${date}T23:59:59Z` UTC-day bounds dropped
   * evening bookings in negative-offset timezones, since an 8pm
   * America/New_York booking is stored on the next UTC day and never fell
   * inside its own local date's UTC window. Bookings and time blocks are
   * matched by interval overlap (start-before-end, end-after-start) rather than
   * start-in-window so a block that begins before the window but runs into it
   * still counts.
   *
   * @param excludeBookingId - booking id to omit; a reschedule must not treat
   *   the booking being moved as a conflict with itself.
   * @param excludeHold - exact soft-hold capability to omit; a booking
   *   completing a held checkout must not treat its own matching hold as a
   *   conflict, while a stale or unrelated id remains occupied.
   */
  const loadOccupiedWith = async (
    d: any,
    startDate: string,
    endDate: string,
    excludeBookingId?: string,
    excludeHold?: { id: string; datetime: string; duration: number },
  ): Promise<OccupiedBlock[]> => {
    const {
      bookings: bookingsTable,
      timeBlocks,
      slotReservations,
    } = (await loadSchemas()).booking;
    const { lt, and, eq, ne, not, isNull, gt } = await import("drizzle-orm");

    const { startIso, endExclusiveIso } = occupiedDayBoundsUtc(
      startDate,
      endDate,
      tz,
    );

    // Active bookings (not cancelled) overlapping the window.
    const bookingConds = [
      lt(bookingsTable.datetime, endExclusiveIso),
      gt(bookingsTable.endTime, startIso),
      ne(bookingsTable.status, "cancelled"),
    ];
    if (excludeBookingId) {
      bookingConds.push(ne(bookingsTable.id, excludeBookingId));
    }
    const bookingRows = await d
      .select({
        datetime: bookingsTable.datetime,
        endTime: bookingsTable.endTime,
      })
      .from(bookingsTable)
      .where(and(...bookingConds));

    // Time blocks overlapping the window.
    const blockRows = await d
      .select({
        startTime: timeBlocks.startTime,
        endTime: timeBlocks.endTime,
      })
      .from(timeBlocks)
      .where(
        and(
          lt(timeBlocks.startTime, endExclusiveIso),
          gt(timeBlocks.endTime, startIso),
        ),
      );

    // Active soft holds (not expired, not released). Reservations carry their
    // duration separately, so query every active hold that starts before the
    // window ends and perform the end-time overlap check in memory. A lower
    // start bound would miss a hold that begins before the window and runs
    // into it.
    const holdConds = [
      lt(slotReservations.datetime, endExclusiveIso),
      gt(slotReservations.expiresAt, new Date().toISOString()),
      isNull(slotReservations.releasedAt),
    ];
    if (excludeHold) {
      // Treat the opaque id as a capability only for the exact candidate it
      // represents. A stale or unrelated id must not suppress another hold.
      holdConds.push(
        not(
          and(
            eq(slotReservations.id, excludeHold.id),
            eq(slotReservations.datetime, excludeHold.datetime),
            eq(slotReservations.duration, excludeHold.duration),
          )!,
        ),
      );
    }
    const softHoldRows = await d
      .select({
        datetime: slotReservations.datetime,
        duration: slotReservations.duration,
      })
      .from(slotReservations)
      .where(and(...holdConds));

    const occupied: OccupiedBlock[] = [];

    for (const r of bookingRows) {
      occupied.push({
        start: new Date(r.datetime),
        end: new Date(r.endTime),
      });
    }
    for (const r of blockRows) {
      occupied.push({
        start: new Date(r.startTime),
        end: new Date(r.endTime),
      });
    }
    for (const r of softHoldRows) {
      const start = new Date(r.datetime);
      occupied.push({
        start,
        end: new Date(start.getTime() + r.duration * 60_000),
      });
    }

    return occupied;
  };

  /** Load occupied blocks for a date range (opens its own executor scope). */
  const loadOccupied = (
    startDate: string,
    endDate: string,
  ): Promise<OccupiedBlock[]> =>
    withDb((d) => loadOccupiedWith(d, startDate, endDate));

  /**
   * Write-time double-booking gate. Re-loads the occupied set for the slot's
   * local date(s) using the supplied executor and rejects the write with a
   * ReservationError(SLOT_TAKEN) when the candidate interval (padded by the
   * configured buffer) overlaps an existing booking, time block, or active
   * soft hold. Call inside the locked critical section so this check and the
   * following insert/update are atomic.
   */
  const assertSlotOpen = async (
    d: any,
    startIso: string,
    endIso: string,
    excludeBookingId?: string,
    excludeHoldId?: string,
  ): Promise<void> => {
    const bufferedStart = new Date(
      new Date(startIso).getTime() - buffer * 60_000,
    );
    const bufferedEnd = new Date(new Date(endIso).getTime() + buffer * 60_000);
    // Query every local day touched by the same padded interval used for the
    // overlap check. Using the unbuffered dates misses adjacent rows across
    // local midnight that conflict only because of the configured buffer.
    const startDate = toDateString(bufferedStart.toISOString(), tz);
    const endDate = toDateString(bufferedEnd.toISOString(), tz);
    const occupied = await loadOccupiedWith(
      d,
      startDate,
      endDate,
      excludeBookingId,
      excludeHoldId
        ? {
            id: excludeHoldId,
            datetime: new Date(startIso).toISOString(),
            duration:
              (new Date(endIso).getTime() - new Date(startIso).getTime()) /
              60_000,
          }
        : undefined,
    );
    if (hasOverlap(bufferedStart, bufferedEnd, occupied)) {
      domainError(
        Errors.reservation(
          "SLOT_TAKEN",
          `Slot ${startIso} is no longer available`,
          startIso,
        ),
      );
    }
  };

  /** Get the default practitioner (requires defaultPractitionerHandle). */
  const getDefaultPractitioner = async (): Promise<any> => {
    if (!practitionerHandle) {
      return domainError(
        Errors.validation(
          "defaultPractitionerHandle",
          "No default practitioner handle configured. Set HomegrownAdapterConfig.defaultPractitionerHandle to the handle of your practice's default practitioner.",
        ),
      );
    }
    const { practitioners } = (await loadSchemas()).content;
    const { eq } = await import("drizzle-orm");
    return withDb(async (d) => {
      const [row] = await d
        .select()
        .from(practitioners)
        .where(eq(practitioners.handle, practitionerHandle))
        .limit(1);
      return row ?? null;
    });
  };

  const loadBookingById = async (
    d: any,
    bookingId: string,
  ): Promise<Booking> => {
    const { content, booking } = await loadSchemas();
    const { bookings: bookingsTable, clients: clientsTable } = booking;
    const { services: servicesTable, practitioners } = content;
    const { eq } = await import("drizzle-orm");

    const [row] = await d
      .select()
      .from(bookingsTable)
      .where(eq(bookingsTable.id, bookingId))
      .limit(1);

    if (!row) {
      return domainError(
        Errors.validation(
          "bookingId",
          `Booking ${bookingId} not found`,
          bookingId,
        ),
      );
    }

    const [svc] = await d
      .select()
      .from(servicesTable)
      .where(eq(servicesTable.id, row.serviceId))
      .limit(1);

    const [client] = await d
      .select()
      .from(clientsTable)
      .where(eq(clientsTable.id, row.clientId))
      .limit(1);

    let providerName: string | undefined;
    if (row.practitionerId) {
      const [prac] = await d
        .select()
        .from(practitioners)
        .where(eq(practitioners.id, row.practitionerId))
        .limit(1);
      providerName = prac?.name;
    }

    return {
      id: row.id,
      serviceId: row.serviceId,
      serviceName: svc?.name ?? "Unknown",
      providerId: row.practitionerId ?? undefined,
      providerName,
      datetime: row.datetime,
      endTime: row.endTime,
      duration: row.duration,
      price: row.amountCents,
      currency: svc?.currency ?? "USD",
      client: {
        firstName: client?.firstName ?? "",
        lastName: client?.lastName ?? "",
        email: client?.email ?? "",
        phone: client?.phone ?? undefined,
      },
      status: row.status as BookingStatus,
      confirmationCode: row.confirmationCode,
      paymentStatus: row.paymentStatus as PaymentStatus,
      paymentRef: row.paymentRef ?? undefined,
      paymentMethod: row.paymentMethod ?? undefined,
      createdAt: row.createdAt,
    } satisfies Booking;
  };

  // ---------------------------------------------------------------------------
  // SchedulingAdapter implementation
  // ---------------------------------------------------------------------------

  const adapter: SchedulingAdapter = {
    name: "homegrown",

    // --- Services ---

    getServices: () =>
      fromAsync(async () => {
        const { services: servicesTable } = (await loadSchemas()).content;
        const { asc, eq } = await import("drizzle-orm");
        const rows = await withDb<any[]>((d) =>
          d
            .select()
            .from(servicesTable)
            .where(eq(servicesTable.active, true))
            .orderBy(asc(servicesTable.displayOrder)),
        );

        return rows.map(
          (r: any): Service => ({
            id: r.id,
            name: r.name,
            description: r.description ?? undefined,
            duration: r.durationMinutes,
            price: r.priceCents,
            currency: r.currency,
            category: r.category ?? undefined,
            active: r.active,
          }),
        );
      }),

    getService: (serviceId: string) =>
      fromAsync(async () => {
        const row = await resolveService(serviceId);
        if (!row) {
          return domainError(
            Errors.validation(
              "serviceId",
              `Service ${serviceId} not found`,
              serviceId,
            ),
          );
        }

        return {
          id: row.id,
          name: row.name,
          description: row.description ?? undefined,
          duration: row.durationMinutes,
          price: row.priceCents,
          currency: row.currency,
          category: row.category ?? undefined,
          active: row.active,
        } satisfies Service;
      }),

    // --- Providers ---

    getProviders: () =>
      fromAsync(async () => {
        const prac = await getDefaultPractitioner();
        if (!prac) return [];
        return [
          {
            id: prac.id,
            name: prac.name,
            email: undefined,
            description: prac.title ?? undefined,
            image: prac.photoUrl ?? undefined,
            timezone: tz,
          } satisfies Provider,
        ];
      }),

    getProvider: (providerId: string) =>
      fromAsync(async () => {
        const { practitioners } = (await loadSchemas()).content;
        const { eq } = await import("drizzle-orm");
        const [row] = await withDb<any[]>((d) =>
          d
            .select()
            .from(practitioners)
            .where(eq(practitioners.id, providerId))
            .limit(1),
        );

        if (!row) {
          return domainError(
            Errors.validation(
              "providerId",
              `Provider ${providerId} not found`,
              providerId,
            ),
          );
        }

        return {
          id: row.id,
          name: row.name,
          email: undefined,
          description: row.title ?? undefined,
          image: row.photoUrl ?? undefined,
          timezone: tz,
        } satisfies Provider;
      }),

    getProvidersForService: (_serviceId: string) =>
      // Solo practice — same as getProviders
      adapter.getProviders(),

    // --- Availability ---

    getAvailableDates: (params) =>
      fromAsync(async () => {
        const hoursMap = await loadHoursMap();
        const overrides = await loadOverrides(params.startDate, params.endDate);
        const occupied = await loadOccupied(params.startDate, params.endDate);

        const svc = await resolveService(params.serviceId);
        if (!svc) {
          return domainError(
            Errors.validation(
              "serviceId",
              `Service ${params.serviceId} not found`,
              params.serviceId,
            ),
          );
        }

        const slotConfig: SlotConfig = {
          duration: svc.durationMinutes,
          interval,
          buffer,
          minAdvanceHours: minAdvance,
          timezone: tz,
        };

        return getDatesWithAvailability(
          params.startDate,
          params.endDate,
          hoursMap,
          overrides,
          occupied,
          slotConfig,
        ).map(
          (r): AvailableDate => ({
            date: r.date,
            slots: r.slots,
          }),
        );
      }),

    getAvailableSlots: (params) =>
      fromAsync(async () => {
        const hoursMap = await loadHoursMap();
        const dayOfWeek = new Date(params.date + "T12:00:00Z").getDay();
        const dayHours = hoursMap.get(dayOfWeek) ?? null;
        const overrides = await loadOverrides(params.date, params.date);
        const override = overrides[0] ?? null;
        const occupied = await loadOccupied(params.date, params.date);

        const svc = await resolveService(params.serviceId);
        if (!svc) {
          return domainError(
            Errors.validation(
              "serviceId",
              `Service ${params.serviceId} not found`,
              params.serviceId,
            ),
          );
        }

        const slotConfig: SlotConfig = {
          duration: svc.durationMinutes,
          interval,
          buffer,
          minAdvanceHours: minAdvance,
          timezone: tz,
        };

        const slots = computeSlots(
          params.date,
          dayHours,
          override,
          occupied,
          slotConfig,
        );

        return slots.map(
          (s): TimeSlot => ({
            datetime: s.datetime,
            available: true,
            providerId: params.providerId,
          }),
        );
      }),

    checkSlotAvailability: (params) =>
      fromAsync(async () => {
        const date = params.datetime.slice(0, 10);
        const hoursMap = await loadHoursMap();
        const dayOfWeek = new Date(date + "T12:00:00Z").getDay();
        const dayHours = hoursMap.get(dayOfWeek) ?? null;
        const overrides = await loadOverrides(date, date);
        const override = overrides[0] ?? null;
        const occupied = await loadOccupied(date, date);

        const svc = await resolveService(params.serviceId);
        if (!svc) {
          return domainError(
            Errors.validation(
              "serviceId",
              `Service ${params.serviceId} not found`,
              params.serviceId,
            ),
          );
        }

        return isSlotAvailable(params.datetime, dayHours, override, occupied, {
          duration: svc.durationMinutes,
          interval,
          buffer,
          minAdvanceHours: minAdvance,
          timezone: tz,
        });
      }),

    // --- Advisory soft holds ---

    softHoldSlot: (params) =>
      fromAsync(async () => {
        const { slotReservations } = (await loadSchemas()).booking;
        const expirationMinutes = params.expirationMinutes ?? 10;
        const start = new Date(params.datetime);
        const end = new Date(start.getTime() + params.duration * 60_000);
        // Homegrown booking writes currently resolve the configured default
        // practitioner, so use that same row id for the lock even when a
        // caller supplied provider metadata on the advisory hold.
        const lockResource = transactional
          ? ((await getDefaultPractitioner())?.id ?? "default")
          : "default";

        const row = await runInTransaction(async (d) => {
          // A hold is the pre-payment admission gate. Serialize it with other
          // holds and booking writes for the same practitioner-day so two
          // checkouts cannot both acquire a hold and charge for one slot.
          if (transactional) {
            await acquireSlotLocks(
              d,
              lockResource,
              start.toISOString(),
              end.toISOString(),
            );
          }
          await assertSlotOpen(d, start.toISOString(), end.toISOString());
          // Start the hold lifetime only after any lock contention and the
          // final availability check. Otherwise a blocked checkout could
          // insert a hold that is already expired when it is returned.
          const expiresAt = new Date(
            Date.now() + expirationMinutes * 60_000,
          ).toISOString();
          const [inserted] = await d
            .insert(slotReservations)
            .values({
              ...tenantValues,
              datetime: start.toISOString(),
              duration: params.duration,
              expiresAt,
            })
            .returning();
          return inserted;
        });

        return {
          id: row.id,
          datetime: row.datetime,
          duration: row.duration,
          expiresAt: row.expiresAt,
          providerId: params.providerId,
        } satisfies SlotSoftHold;
      }),

    releaseSoftHold: (softHoldId: string) =>
      fromAsync(async () => {
        const { slotReservations } = (await loadSchemas()).booking;
        const { eq } = await import("drizzle-orm");
        await withDb((d) =>
          d
            .update(slotReservations)
            .set({ releasedAt: new Date().toISOString() })
            .where(eq(slotReservations.id, softHoldId)),
        );
      }),

    // --- Bookings ---

    createBooking: (request: BookingRequest) =>
      fromAsync(async () => {
        const { bookings: bookingsTable } = (await loadSchemas()).booking;
        const { eq } = await import("drizzle-orm");

        /**
         * Look up an existing booking by idempotency key inside the scoped
         * executor and return the fully mapped Booking on hit.
         */
        const findByIdempotencyKey = (): Promise<Booking | null> =>
          withDb(async (d) => {
            const [existing] = await d
              .select()
              .from(bookingsTable)
              .where(eq(bookingsTable.idempotencyKey, request.idempotencyKey))
              .limit(1);
            return existing ? loadBookingById(d, existing.id) : null;
          });

        // Idempotent replay: a duplicate submit with the same key returns the
        // original booking instead of inserting a second row.
        //
        // Replay-wins semantics: the request payload is NOT compared against
        // the stored row — a caller reusing a key with a different payload
        // receives the original booking (keys are caller-controlled; see
        // BookingRequest.idempotencyKey). Empty-string keys are treated the
        // same as absent keys (no dedup) and are normalized to null on insert.
        if (request.idempotencyKey) {
          const replay = await findByIdempotencyKey();
          if (replay) return replay;
        }

        // Resolve service (by UUID or acuityId)
        const svc = await resolveService(request.serviceId);
        if (!svc) {
          return domainError(
            Errors.validation(
              "serviceId",
              `Service ${request.serviceId} not found`,
              request.serviceId,
            ),
          );
        }

        // Find or create client
        const clientResult = await Effect.runPromise(
          adapter.findOrCreateClient(request.client),
        );
        const clientId = clientResult.id;

        // Get practitioner
        const prac = await getDefaultPractitioner();

        const startDt = new Date(request.datetime);
        const endDt = new Date(
          startDt.getTime() + svc.durationMinutes * 60_000,
        );
        const confirmationCode = generateConfirmationCode(
          confirmationCodePrefix,
        );

        let row: any;
        try {
          row = await runInTransaction(async (d) => {
            // Serialize concurrent writers for this practitioner + local day
            // so the availability re-check and the insert are one atomic
            // critical section even when the writers target overlapping but
            // different start times. Only meaningful inside a real
            // transaction, so the withDb fallback path skips the lock.
            if (transactional) {
              await acquireSlotLocks(
                d,
                prac?.id ?? "default",
                startDt.toISOString(),
                endDt.toISOString(),
              );
            }
            // Write-time double-booking gate: re-validate the slot inside the
            // locked section and reject it if it is no longer free. The
            // caller's own soft hold (when threaded through the request) is
            // excluded, mirroring rescheduleBooking's booking self-exclusion;
            // without it every held checkout would fail its own booking.
            await assertSlotOpen(
              d,
              startDt.toISOString(),
              endDt.toISOString(),
              undefined,
              request.softHoldId,
            );
            const [inserted] = await d
              .insert(bookingsTable)
              .values({
                ...tenantValues,
                confirmationCode,
                serviceId: svc.id,
                practitionerId: prac?.id,
                clientId,
                datetime: startDt.toISOString(),
                endTime: endDt.toISOString(),
                duration: svc.durationMinutes,
                status: "confirmed",
                paymentStatus: "pending",
                paymentMethod: request.paymentMethod ?? null,
                amountCents: svc.priceCents,
                // Normalize "" to null so an unusable key never occupies the
                // (schema-package-owned) unique index slot.
                idempotencyKey: request.idempotencyKey || null,
              })
              .returning();
            return inserted;
          });
        } catch (e) {
          // Concurrent duplicate submit: if the underlying table enforces a
          // unique index on idempotency_key (schema is owned by the schema
          // package, not this kit), a race between the pre-insert lookup and
          // the insert surfaces as a unique violation. Recover by replaying
          // the winning row.
          if (request.idempotencyKey && isUniqueViolation(e)) {
            // Guard the replay lookup: if it fails too (e.g. transient
            // connection error), keep the original unique violation as the
            // surfaced root cause instead of the secondary failure.
            let replay: Booking | null = null;
            try {
              replay = await findByIdempotencyKey();
            } catch {
              throw e;
            }
            if (replay) return replay;
          }
          throw e;
        }

        return {
          id: row.id,
          serviceId: svc.id,
          serviceName: svc.name,
          providerId: prac?.id,
          providerName: prac?.name,
          datetime: row.datetime,
          endTime: row.endTime,
          duration: row.duration,
          price: row.amountCents,
          currency: svc.currency,
          client: request.client,
          status: row.status as BookingStatus,
          confirmationCode: row.confirmationCode,
          paymentStatus: row.paymentStatus as PaymentStatus,
          paymentMethod: row.paymentMethod ?? undefined,
          createdAt: row.createdAt,
        } satisfies Booking;
      }),

    createBookingWithPaymentRef: (
      request: BookingRequest,
      paymentRef: string,
      paymentProcessor: string,
    ) =>
      Effect.flatMap(adapter.createBooking(request), (booking) =>
        fromAsync(async () => {
          const { bookings: bookingsTable } = (await loadSchemas()).booking;
          const { eq } = await import("drizzle-orm");

          await withDb((d) =>
            d
              .update(bookingsTable)
              .set({
                paymentRef,
                paymentMethod: paymentProcessor,
                paymentStatus: "paid",
              })
              .where(eq(bookingsTable.id, booking.id)),
          );

          return {
            ...booking,
            paymentRef,
            paymentMethod: paymentProcessor,
            paymentStatus: "paid" as const,
          };
        }),
      ),

    getBooking: (bookingId: string) =>
      fromAsync(async () => {
        return withDb((d) => loadBookingById(d, bookingId));
      }),

    cancelBooking: (bookingId: string, reason?: string) =>
      fromAsync(async () => {
        const { bookings: bookingsTable } = (await loadSchemas()).booking;
        const { eq } = await import("drizzle-orm");

        await withDb((d) =>
          d
            .update(bookingsTable)
            .set({
              status: "cancelled",
              cancelledAt: new Date().toISOString(),
              cancelReason: reason ?? null,
              updatedAt: new Date().toISOString(),
            })
            .where(eq(bookingsTable.id, bookingId)),
        );
      }),

    rescheduleBooking: (bookingId: string, newDatetime: string) =>
      fromAsync(async () => {
        const { bookings: bookingsTable } = (await loadSchemas()).booking;
        const { eq } = await import("drizzle-orm");

        return runInTransaction(async (d) => {
          const [row] = await d
            .select()
            .from(bookingsTable)
            .where(eq(bookingsTable.id, bookingId))
            .limit(1);

          if (!row) {
            return domainError(
              Errors.validation(
                "bookingId",
                `Booking ${bookingId} not found`,
                bookingId,
              ),
            );
          }

          // A cancelled or completed booking is terminal: reschedule would
          // resurrect a closed appointment, so refuse it.
          if (row.status === "cancelled" || row.status === "completed") {
            return domainError(
              Errors.validation(
                "status",
                `Cannot reschedule a ${row.status} booking`,
                row.status,
              ),
            );
          }

          const newStart = new Date(newDatetime);
          const newEnd = new Date(newStart.getTime() + row.duration * 60_000);

          // Old slot needs no lock: vacating a block cannot create conflicts.
          if (transactional) {
            await acquireSlotLocks(
              d,
              row.practitionerId ?? "default",
              newStart.toISOString(),
              newEnd.toISOString(),
            );
          }
          // Write-time double-booking gate for the new slot. Exclude this
          // booking so its own current block is not treated as a conflict.
          await assertSlotOpen(
            d,
            newStart.toISOString(),
            newEnd.toISOString(),
            bookingId,
          );

          await d
            .update(bookingsTable)
            .set({
              datetime: newStart.toISOString(),
              endTime: newEnd.toISOString(),
              updatedAt: new Date().toISOString(),
            })
            .where(eq(bookingsTable.id, bookingId));

          return loadBookingById(d, bookingId);
        });
      }),

    // --- Clients ---

    findOrCreateClient: (client: ClientInfo) =>
      fromAsync(async () => {
        const { clients: clientsTable } = (await loadSchemas()).booking;
        const { eq } = await import("drizzle-orm");
        return withDb(async (d) => {
          // Try to find existing
          const [existing] = await d
            .select()
            .from(clientsTable)
            .where(eq(clientsTable.email, client.email))
            .limit(1);

          if (existing) {
            // Update name/phone if changed
            await d
              .update(clientsTable)
              .set({
                firstName: client.firstName,
                lastName: client.lastName,
                phone: client.phone ?? existing.phone,
                updatedAt: new Date().toISOString(),
              })
              .where(eq(clientsTable.id, existing.id));

            return { id: existing.id, isNew: false };
          }

          // Create new
          const [row] = await d
            .insert(clientsTable)
            .values({
              ...tenantValues,
              firstName: client.firstName,
              lastName: client.lastName,
              email: client.email,
              phone: client.phone ?? null,
              notes: client.notes ?? null,
              customFields: client.customFields ?? {},
            })
            .returning();

          return { id: row.id, isNew: true };
        });
      }),

    getClientByEmail: (email: string) =>
      fromAsync(async () => {
        const { clients: clientsTable } = (await loadSchemas()).booking;
        const { eq } = await import("drizzle-orm");
        const [row] = await withDb<any[]>((d) =>
          d
            .select()
            .from(clientsTable)
            .where(eq(clientsTable.email, email))
            .limit(1),
        );

        if (!row) return null;

        return {
          firstName: row.firstName,
          lastName: row.lastName,
          email: row.email,
          phone: row.phone ?? undefined,
          notes: row.notes ?? undefined,
        } satisfies ClientInfo;
      }),
  };

  return adapter;
};
