/**
 * HomegrownAdapter Unit Tests
 *
 * Tests adapter behavior by mocking the Drizzle DB layer.
 * The adapter delegates availability math to availability-engine.ts
 * (already covered by 39 tests), so these tests focus on:
 *
 *   - DB row → domain type mapping
 *   - Effect wrapping and error surfacing
 *   - Service resolution (UUID vs acuityId)
 *   - Find-or-create client logic
 *   - Booking lifecycle (create → get → cancel/reschedule)
 *   - Reservation create/release
 *   - Provider lookup (solo practice pattern)
 *   - Optional server tenant value propagation (not database/RLS isolation)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Effect } from "effect";
import {
  createHomegrownAdapter,
  type HomegrownAdapterConfig,
} from "../homegrown.js";

// ---------------------------------------------------------------------------
// Mock schemas — minimal shape matching what Drizzle ORM tables expose
// ---------------------------------------------------------------------------

const mockServicesTable = {
  id: "id",
  name: "name",
  active: "active",
  displayOrder: "displayOrder",
  acuityId: "acuityId",
};
const mockPractitionersTable = { id: "id", handle: "handle", name: "name" };
const mockBusinessHoursTable = { dayOfWeek: "dayOfWeek" };
const mockBusinessHoursOverridesTable = { date: "date" };
const mockBookingsTable = {
  id: "id",
  datetime: "datetime",
  endTime: "endTime",
  status: "status",
  serviceId: "serviceId",
  clientId: "clientId",
  practitionerId: "practitionerId",
  idempotencyKey: "idempotencyKey",
};
const mockTimeBlocksTable = { startTime: "startTime", endTime: "endTime" };
const mockSlotReservationsTable = {
  datetime: "datetime",
  duration: "duration",
  expiresAt: "expiresAt",
  releasedAt: "releasedAt",
  id: "id",
};
const mockClientsTable = { id: "id", email: "email" };

const testSchemas = {
  content: {
    services: mockServicesTable,
    practitioners: mockPractitionersTable,
    businessHours: mockBusinessHoursTable,
  },
  booking: {
    bookings: mockBookingsTable,
    timeBlocks: mockTimeBlocksTable,
    slotReservations: mockSlotReservationsTable,
    clients: mockClientsTable,
    businessHoursOverrides: mockBusinessHoursOverridesTable,
  },
};

const createAdapter = (config: HomegrownAdapterConfig) =>
  createHomegrownAdapter({
    schemas: testSchemas,
    // There is no built-in fallback handle anymore; tests configure an
    // anonymized one explicitly (override per-test as needed).
    defaultPractitionerHandle: "alex",
    ...config,
  });

// Mock drizzle-orm operators — return identity functions for where-clause building
vi.mock("drizzle-orm", () => ({
  eq: (col: string, val: unknown) => ({ op: "eq", col, val }),
  or: (...args: unknown[]) => ({ op: "or", args }),
  and: (...args: unknown[]) => ({ op: "and", args }),
  asc: (col: string) => ({ op: "asc", col }),
  ne: (col: string, val: unknown) => ({ op: "ne", col, val }),
  gte: (col: string, val: unknown) => ({ op: "gte", col, val }),
  lte: (col: string, val: unknown) => ({ op: "lte", col, val }),
  lt: (col: string, val: unknown) => ({ op: "lt", col, val }),
  gt: (col: string, val: unknown) => ({ op: "gt", col, val }),
  isNull: (col: string) => ({ op: "isNull", col }),
  not: (arg: unknown) => ({ op: "not", arg }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    strings,
    values,
  }),
}));

// ---------------------------------------------------------------------------
// Mock DB builder — fluent Drizzle-like chain that returns canned rows
// ---------------------------------------------------------------------------

type MockRow = Record<string, unknown>;

/**
 * A Drizzle select terminal that is awaitable directly (a bare `.where()` with
 * no `.limit()`/`.orderBy()`) AND exposes `.limit()`/`.orderBy()`. The adapter
 * consumes selects both ways: `loadOccupied` awaits `.where()` with no terminal
 * (real Drizzle queries are thenable), while row lookups chain `.limit(1)` or
 * `.orderBy(...)`. An `Error` entry rejects on either path.
 */
const selectTerminal = (entry: MockRow[] | Error) => {
  const p =
    entry instanceof Error ? Promise.reject(entry) : Promise.resolve(entry);
  // Suppress unhandled-rejection noise on the branch that is never awaited.
  p.catch(() => {});
  const settle =
    entry instanceof Error
      ? vi.fn().mockRejectedValue(entry)
      : vi.fn().mockResolvedValue(entry);
  return {
    then: p.then.bind(p),
    catch: p.catch.bind(p),
    finally: p.finally.bind(p),
    limit: settle,
    orderBy: settle,
  };
};

const createMockDb = (
  responses: {
    select?: MockRow[];
    insert?: MockRow[];
    update?: MockRow[];
  } = {},
) => {
  const selectRows = responses.select ?? [];
  const insertRows = responses.insert ?? [];

  const chainTerminals = {
    limit: vi.fn().mockResolvedValue(selectRows),
    orderBy: vi.fn().mockResolvedValue(selectRows),
    returning: vi.fn().mockResolvedValue(insertRows),
  };

  const chain = {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue(chainTerminals),
      orderBy: chainTerminals.orderBy,
      limit: chainTerminals.limit,
    }),
    where: vi.fn().mockReturnValue(chainTerminals),
    values: vi.fn().mockReturnValue({
      returning: chainTerminals.returning,
    }),
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
  };

  const db = {
    select: vi.fn().mockReturnValue(chain),
    insert: vi.fn().mockReturnValue(chain),
    update: vi.fn().mockReturnValue(chain),
    _chain: chain,
    _terminals: chainTerminals,
  };

  return db;
};

/**
 * Sequenced mock DB — returns different rows for successive select/insert calls.
 * Used for multi-step methods like createBooking and getBooking which make
 * multiple sequential DB queries against different tables.
 */
const createSequencedMockDb = (
  selectSequence: MockRow[][],
  insertSequence: MockRow[][] = [],
) => {
  let selectCall = 0;
  let insertCall = 0;

  const makeSelectChain = () => {
    const rows = selectSequence[selectCall] ?? [];
    selectCall++;
    const terminals = selectTerminal(rows);
    return {
      where: vi.fn().mockReturnValue(terminals),
      orderBy: terminals.orderBy,
      limit: terminals.limit,
    };
  };

  const makeInsertChain = () => {
    const rows = insertSequence[insertCall] ?? [];
    insertCall++;
    return {
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue(rows),
      }),
    };
  };

  return {
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation(makeSelectChain),
    })),
    insert: vi.fn().mockImplementation(makeInsertChain),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
  };
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TRUSTED_TENANT_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_TENANT_ID = "10000000-0000-4000-8000-000000000002";

const SERVICE_ROW = {
  id: "svc-uuid-1",
  name: "Deep Tissue Massage",
  description: "60-minute therapeutic session",
  durationMinutes: 60,
  priceCents: 9500,
  currency: "USD",
  category: "therapeutic",
  active: true,
  displayOrder: 1,
  acuityId: "12345",
};

const PRACTITIONER_ROW = {
  id: "prac-uuid-1",
  handle: "alex",
  name: "Alex Rivera",
  title: "Licensed Massage Therapist",
  photoUrl: "https://example.com/alex.jpg",
};

const CLIENT_ROW = {
  id: "client-uuid-1",
  firstName: "Alice",
  lastName: "Smith",
  email: "alice@example.com",
  phone: "607-555-1234",
  notes: null,
  createdAt: "2026-04-10T12:00:00Z",
  updatedAt: "2026-04-10T12:00:00Z",
};

const BOOKING_ROW = {
  id: "booking-uuid-1",
  confirmationCode: "ABC123",
  serviceId: "svc-uuid-1",
  practitionerId: "prac-uuid-1",
  clientId: "client-uuid-1",
  datetime: "2026-04-20T14:00:00.000Z",
  endTime: "2026-04-20T15:00:00.000Z",
  duration: 60,
  status: "confirmed",
  paymentStatus: "pending",
  paymentMethod: null,
  amountCents: 9500,
  paymentRef: null,
  createdAt: "2026-04-18T10:00:00.000Z",
  cancelledAt: null,
  cancelReason: null,
  updatedAt: null,
};

const RESERVATION_ROW = {
  id: "res-uuid-1",
  datetime: "2026-04-20T14:00:00.000Z",
  duration: 60,
  expiresAt: "2026-04-20T14:10:00.000Z",
};

const TEST_CLIENT: {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
} = {
  firstName: "Alice",
  lastName: "Smith",
  email: "alice@example.com",
  phone: "607-555-1234",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("HomegrownAdapter", () => {
  describe("creation and configuration", () => {
    it('creates an adapter with name "homegrown"', () => {
      const adapter = createAdapter({ getDb: async () => ({}) });
      expect(adapter.name).toBe("homegrown");
    });

    it("creates an adapter with a scoped database executor only", () => {
      const adapter = createAdapter({
        withDb: async (fn) => fn({}),
      });
      expect(adapter.name).toBe("homegrown");
    });

    it("throws immediately when no database accessor is configured", () => {
      expect(() => createAdapter({})).toThrow(
        "HomegrownAdapter requires either getDb or withDb",
      );
    });

    it.each(["", "not-a-uuid", `${TRUSTED_TENANT_ID} `])(
      "rejects malformed server tenant identity before database access: %s",
      (tenantId) => {
        const getDb = vi.fn();
        expect(() => createAdapter({ getDb, tenantId })).toThrow(
          "HomegrownAdapter tenantId must be a UUID when supplied",
        );
        expect(getDb).not.toHaveBeenCalled();
      },
    );

    it("uses scoped database executor when provided", async () => {
      const mockDb = createMockDb();
      mockDb._terminals.orderBy.mockResolvedValue([SERVICE_ROW]);
      const getDb = vi.fn(async () => mockDb);
      const withDb = vi.fn(async (fn) => fn(mockDb));

      const adapter = createAdapter({ getDb, withDb });
      const result = await Effect.runPromise(adapter.getServices());

      expect(result).toHaveLength(1);
      expect(withDb).toHaveBeenCalledOnce();
      expect(getDb).not.toHaveBeenCalled();
    });

    it("exposes all 16+1 SchedulingAdapter methods", () => {
      const adapter = createAdapter({ getDb: async () => ({}) });
      const methods = [
        "getServices",
        "getService",
        "getProviders",
        "getProvider",
        "getProvidersForService",
        "getAvailableDates",
        "getAvailableSlots",
        "checkSlotAvailability",
        "softHoldSlot",
        "releaseSoftHold",
        "createBooking",
        "createBookingWithPaymentRef",
        "getBooking",
        "cancelBooking",
        "rescheduleBooking",
        "findOrCreateClient",
        "getClientByEmail",
      ];
      for (const m of methods) {
        expect(typeof (adapter as any)[m]).toBe("function");
      }
    });

    it("accepts custom configuration", () => {
      const adapter = createAdapter({
        getDb: async () => ({}),
        timezone: "America/Chicago",
        slotInterval: 15,
        bufferMinutes: 10,
        minAdvanceHours: 4,
        defaultPractitionerHandle: "jess",
      });
      expect(adapter.name).toBe("homegrown");
    });
  });

  // -------------------------------------------------------------------------
  // Services
  // -------------------------------------------------------------------------

  describe("getServices", () => {
    it("returns active services mapped to Service domain type", async () => {
      const mockDb = createMockDb();
      // orderBy terminal returns the service rows
      mockDb._terminals.orderBy.mockResolvedValue([SERVICE_ROW]);

      const adapter = createAdapter({ getDb: async () => mockDb });
      const result = await Effect.runPromise(adapter.getServices());

      expect(result).toEqual([
        {
          id: "svc-uuid-1",
          name: "Deep Tissue Massage",
          description: "60-minute therapeutic session",
          duration: 60,
          price: 9500,
          currency: "USD",
          category: "therapeutic",
          active: true,
        },
      ]);
    });

    it("returns empty array when no active services exist", async () => {
      const mockDb = createMockDb();
      mockDb._terminals.orderBy.mockResolvedValue([]);

      const adapter = createAdapter({ getDb: async () => mockDb });
      const result = await Effect.runPromise(adapter.getServices());

      expect(result).toEqual([]);
    });

    it("maps null description to undefined", async () => {
      const mockDb = createMockDb();
      mockDb._terminals.orderBy.mockResolvedValue([
        { ...SERVICE_ROW, description: null, category: null },
      ]);

      const adapter = createAdapter({ getDb: async () => mockDb });
      const result = await Effect.runPromise(adapter.getServices());

      expect(result[0].description).toBeUndefined();
      expect(result[0].category).toBeUndefined();
    });

    it("surfaces DB errors as InfrastructureError via Effect", async () => {
      const mockDb = createMockDb();
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockRejectedValue(new Error("connection refused")),
            limit: vi.fn().mockRejectedValue(new Error("connection refused")),
          }),
          orderBy: vi.fn().mockRejectedValue(new Error("connection refused")),
        }),
      });

      const adapter = createAdapter({ getDb: async () => mockDb });
      const result = await Effect.runPromiseExit(adapter.getServices());

      expect(result._tag).toBe("Failure");
    });
  });

  describe("getService", () => {
    it("resolves service by UUID", async () => {
      const mockDb = createMockDb({ select: [SERVICE_ROW] });
      const adapter = createAdapter({ getDb: async () => mockDb });

      const result = await Effect.runPromise(
        adapter.getService("a1b2c3d4-e5f6-7890-abcd-ef1234567890"),
      );

      expect(result.id).toBe("svc-uuid-1");
      expect(result.name).toBe("Deep Tissue Massage");
      expect(result.duration).toBe(60);
      expect(result.price).toBe(9500);
    });

    it("resolves service by acuityId (non-UUID string)", async () => {
      const mockDb = createMockDb({ select: [SERVICE_ROW] });
      const adapter = createAdapter({ getDb: async () => mockDb });

      const result = await Effect.runPromise(adapter.getService("12345"));

      expect(result.id).toBe("svc-uuid-1");
    });

    it("fails when service not found", async () => {
      const mockDb = createMockDb({ select: [] });
      mockDb._terminals.limit.mockResolvedValue([]);

      const adapter = createAdapter({ getDb: async () => mockDb });
      const result = await Effect.runPromiseExit(
        adapter.getService("nonexistent"),
      );

      expect(result._tag).toBe("Failure");
    });
  });

  // -------------------------------------------------------------------------
  // Providers
  // -------------------------------------------------------------------------

  describe("getProviders", () => {
    it("returns the default practitioner as a Provider", async () => {
      const mockDb = createMockDb({ select: [PRACTITIONER_ROW] });
      const adapter = createAdapter({ getDb: async () => mockDb });

      const result = await Effect.runPromise(adapter.getProviders());

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        id: "prac-uuid-1",
        name: "Alex Rivera",
        email: undefined,
        description: "Licensed Massage Therapist",
        image: "https://example.com/alex.jpg",
        timezone: "America/New_York",
      });
    });

    it("returns empty array when no practitioner found", async () => {
      const mockDb = createMockDb({ select: [] });
      mockDb._terminals.limit.mockResolvedValue([]);

      const adapter = createAdapter({ getDb: async () => mockDb });
      const result = await Effect.runPromise(adapter.getProviders());

      expect(result).toEqual([]);
    });

    it("uses custom timezone from config", async () => {
      const mockDb = createMockDb({ select: [PRACTITIONER_ROW] });
      const adapter = createAdapter({
        getDb: async () => mockDb,
        timezone: "America/Chicago",
      });

      const result = await Effect.runPromise(adapter.getProviders());
      expect(result[0].timezone).toBe("America/Chicago");
    });
  });

  describe("getProvider", () => {
    it("returns a specific provider by ID", async () => {
      const mockDb = createMockDb({ select: [PRACTITIONER_ROW] });
      const adapter = createAdapter({ getDb: async () => mockDb });

      const result = await Effect.runPromise(
        adapter.getProvider("prac-uuid-1"),
      );

      expect(result.id).toBe("prac-uuid-1");
      expect(result.name).toBe("Alex Rivera");
    });

    it("fails when provider not found", async () => {
      const mockDb = createMockDb({ select: [] });
      mockDb._terminals.limit.mockResolvedValue([]);

      const adapter = createAdapter({ getDb: async () => mockDb });
      const result = await Effect.runPromiseExit(
        adapter.getProvider("nonexistent"),
      );

      expect(result._tag).toBe("Failure");
    });
  });

  describe("getProvidersForService", () => {
    it("delegates to getProviders (solo practice)", async () => {
      const mockDb = createMockDb({ select: [PRACTITIONER_ROW] });
      const adapter = createAdapter({ getDb: async () => mockDb });

      const result = await Effect.runPromise(
        adapter.getProvidersForService("any-service"),
      );

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("prac-uuid-1");
    });
  });

  // -------------------------------------------------------------------------
  // Reservations
  // -------------------------------------------------------------------------

  describe("softHoldSlot", () => {
    it.each([undefined, TRUSTED_TENANT_ID])("inserts an advisory soft hold and returns SlotSoftHold (tenantId=%s)", async (tenantId) => {
      const mockDb = createSequencedMockDb(
        [[], [], []], // occupied bookings, time blocks, active holds
        [[RESERVATION_ROW]],
      );
      const adapter = createAdapter({ getDb: async () => mockDb, tenantId });

      const result = await Effect.runPromise(
        adapter.softHoldSlot({
          serviceId: "svc-uuid-1",
          providerId: "prac-uuid-1",
          datetime: "2026-04-20T14:00:00.000Z",
          duration: 60,
          expirationMinutes: 10,
        }),
      );

      expect(result).toEqual({
        id: "res-uuid-1",
        datetime: "2026-04-20T14:00:00.000Z",
        duration: 60,
        expiresAt: "2026-04-20T14:10:00.000Z",
        providerId: "prac-uuid-1",
      });
      const values = mockDb.insert.mock.results[0].value.values.mock.calls[0][0];
      if (tenantId === undefined) expect(values).not.toHaveProperty("tenantId");
      else expect(values.tenantId).toBe(tenantId);
    });

    it("defaults expiration to 10 minutes when not specified", async () => {
      const mockDb = createSequencedMockDb(
        [[], [], []], // occupied bookings, time blocks, active holds
        [[RESERVATION_ROW]],
      );
      const adapter = createAdapter({ getDb: async () => mockDb });

      // The adapter calculates expiresAt internally — we just verify the
      // insert goes through and returns the DB row
      const result = await Effect.runPromise(
        adapter.softHoldSlot({
          serviceId: "svc-uuid-1",
          datetime: "2026-04-20T14:00:00.000Z",
          duration: 60,
        }),
      );

      expect(result.id).toBe("res-uuid-1");
    });

    it("starts expiration after waiting for the practitioner-day lock", async () => {
      const initialNow = new Date("2026-04-20T13:00:00.000Z").getTime();
      let now = initialNow;
      const dateNow = vi.spyOn(Date, "now").mockImplementation(() => now);
      const mockDb = Object.assign(
        createSequencedMockDb(
          [[PRACTITIONER_ROW], [], [], []],
          [[RESERVATION_ROW]],
        ),
        {
          execute: vi.fn().mockImplementation(async () => {
            // Simulate lock contention longer than the requested hold TTL.
            now = initialNow + 11 * 60_000;
          }),
        },
      );

      try {
        const adapter = createAdapter({
          getDb: async () => mockDb,
          withTransaction: (fn) => fn(mockDb),
        });

        await Effect.runPromise(
          adapter.softHoldSlot({
            serviceId: "svc-uuid-1",
            datetime: "2026-04-20T14:00:00.000Z",
            duration: 60,
            expirationMinutes: 10,
          }),
        );

        const insertChain = mockDb.insert.mock.results[0]?.value;
        expect(insertChain.values).toHaveBeenCalledWith(
          expect.objectContaining({
            expiresAt: "2026-04-20T13:21:00.000Z",
          }),
        );
      } finally {
        dateNow.mockRestore();
      }
    });
  });

  describe("releaseSoftHold", () => {
    it("sets releasedAt on the soft hold", async () => {
      const mockDb = createMockDb();
      const adapter = createAdapter({ getDb: async () => mockDb });

      // releaseSoftHold returns void — just ensure no throw
      await expect(
        Effect.runPromise(adapter.releaseSoftHold("res-uuid-1")),
      ).resolves.toBeUndefined();

      expect(mockDb.update).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Clients
  // -------------------------------------------------------------------------

  describe("findOrCreateClient", () => {
    it("returns existing client with isNew=false and updates info", async () => {
      const mockDb = createMockDb({ select: [CLIENT_ROW] });
      const adapter = createAdapter({ getDb: async () => mockDb });

      const result = await Effect.runPromise(
        adapter.findOrCreateClient(TEST_CLIENT),
      );

      expect(result).toEqual({ id: "client-uuid-1", isNew: false });
      // Should have called update to refresh name/phone
      expect(mockDb.update).toHaveBeenCalled();
    });

    it.each([undefined, TRUSTED_TENANT_ID])("creates new client when email not found (tenantId=%s)", async (tenantId) => {
      const mockDb = createMockDb();
      // First select (find by email) returns empty
      mockDb._terminals.limit.mockResolvedValue([]);
      // Insert returns new row
      mockDb._terminals.returning.mockResolvedValue([
        { id: "client-uuid-new" },
      ]);

      const config = {
        schemas: testSchemas,
        defaultPractitionerHandle: "alex",
        getDb: async () => mockDb,
        tenantId,
      };
      const adapter = createHomegrownAdapter(config);
      config.tenantId = OTHER_TENANT_ID;

      const result = await Effect.runPromise(
        adapter.findOrCreateClient(TEST_CLIENT),
      );

      expect(result).toEqual({ id: "client-uuid-new", isNew: true });
      expect(mockDb.insert).toHaveBeenCalled();
      // The factory snapshots the binding; changing the original config cannot
      // redirect it. This is a call-argument unit contract, not canonical PG proof.
      const values = mockDb._chain.values.mock.calls[0][0];
      if (tenantId === undefined) expect(values).not.toHaveProperty("tenantId");
      else expect(values.tenantId).toBe(tenantId);
    });
  });

  describe("getClientByEmail", () => {
    it("returns ClientInfo when client exists", async () => {
      const mockDb = createMockDb({ select: [CLIENT_ROW] });
      const adapter = createAdapter({ getDb: async () => mockDb });

      const result = await Effect.runPromise(
        adapter.getClientByEmail("alice@example.com"),
      );

      expect(result).toEqual({
        firstName: "Alice",
        lastName: "Smith",
        email: "alice@example.com",
        phone: "607-555-1234",
        notes: undefined,
      });
    });

    it("returns null when client not found", async () => {
      const mockDb = createMockDb({ select: [] });
      mockDb._terminals.limit.mockResolvedValue([]);

      const adapter = createAdapter({ getDb: async () => mockDb });

      const result = await Effect.runPromise(
        adapter.getClientByEmail("nobody@example.com"),
      );

      expect(result).toBeNull();
    });

    it("maps null phone/notes to undefined", async () => {
      const mockDb = createMockDb({
        select: [{ ...CLIENT_ROW, phone: null, notes: null }],
      });
      const adapter = createAdapter({ getDb: async () => mockDb });

      const result = await Effect.runPromise(
        adapter.getClientByEmail("alice@example.com"),
      );

      expect(result?.phone).toBeUndefined();
      expect(result?.notes).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Bookings
  // -------------------------------------------------------------------------

  describe("cancelBooking", () => {
    it("sets status to cancelled", async () => {
      const mockDb = createMockDb();
      const adapter = createAdapter({ getDb: async () => mockDb });

      await expect(
        Effect.runPromise(
          adapter.cancelBooking("booking-uuid-1", "schedule conflict"),
        ),
      ).resolves.toBeUndefined();

      expect(mockDb.update).toHaveBeenCalled();
    });

    it("works without a reason", async () => {
      const mockDb = createMockDb();
      const adapter = createAdapter({ getDb: async () => mockDb });

      await expect(
        Effect.runPromise(adapter.cancelBooking("booking-uuid-1")),
      ).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Bookings — multi-step (sequenced mock)
  // -------------------------------------------------------------------------

  describe("createBooking", () => {
    it.each([undefined, TRUSTED_TENANT_ID])("resolves service, finds client, gets practitioner, inserts booking (tenantId=%s)", async (tenantId) => {
      // createBooking internally calls:
      //   1. idempotency pre-lookup (select, miss)
      //   2. resolveService (select)
      //   3. findOrCreateClient → find by email (select) → update if exists
      //   4. getDefaultPractitioner (select)
      //   5. insert booking
      const mockDb = createSequencedMockDb(
        [
          [], // idempotency pre-lookup (no existing booking)
          [SERVICE_ROW], // resolveService
          [CLIENT_ROW], // findOrCreateClient email lookup
          [PRACTITIONER_ROW], // getDefaultPractitioner
          [], // write gate: occupied bookings
          [], // write gate: occupied time blocks
          [], // write gate: active soft holds
        ],
        [
          [BOOKING_ROW], // insert booking
        ],
      );

      const adapter = createAdapter({ getDb: async () => mockDb, tenantId });
      const request = {
        serviceId: "svc-uuid-1",
        datetime: "2026-04-20T14:00:00.000Z",
        client: TEST_CLIENT,
        idempotencyKey: "idem-001",
        tenantId: OTHER_TENANT_ID, // Extra untrusted payload is not configuration.
      };
      const result = await Effect.runPromise(adapter.createBooking(request));

      expect(result.id).toBe("booking-uuid-1");
      expect(result.serviceId).toBe("svc-uuid-1");
      expect(result.serviceName).toBe("Deep Tissue Massage");
      expect(result.confirmationCode).toBe("ABC123");
      expect(result.status).toBe("confirmed");
      expect(result.paymentStatus).toBe("pending");
      expect(result.client).toEqual(TEST_CLIENT);
      const values = mockDb.insert.mock.results[0].value.values.mock.calls[0][0];
      if (tenantId === undefined) expect(values).not.toHaveProperty("tenantId");
      else expect(values.tenantId).toBe(tenantId);
    });

    it("fails when service not found during booking", async () => {
      const mockDb = createSequencedMockDb([
        [], // idempotency pre-lookup (no existing booking)
        [], // resolveService returns empty
      ]);

      const adapter = createAdapter({ getDb: async () => mockDb });
      const exit = await Effect.runPromiseExit(
        adapter.createBooking({
          serviceId: "nonexistent",
          datetime: "2026-04-20T14:00:00.000Z",
          client: TEST_CLIENT,
          idempotencyKey: "idem-002",
        }),
      );

      expect(exit._tag).toBe("Failure");
    });

    it("creates new client when email not found during booking", async () => {
      const mockDb = createSequencedMockDb(
        [
          [], // idempotency pre-lookup (no existing booking)
          [SERVICE_ROW], // resolveService
          [], // findOrCreateClient: email not found
          [PRACTITIONER_ROW], // getDefaultPractitioner
          [], // write gate: occupied bookings
          [], // write gate: occupied time blocks
          [], // write gate: active soft holds
        ],
        [
          [{ id: "client-uuid-new" }], // insert client
          [BOOKING_ROW], // insert booking
        ],
      );

      const adapter = createAdapter({ getDb: async () => mockDb });
      const result = await Effect.runPromise(
        adapter.createBooking({
          serviceId: "svc-uuid-1",
          datetime: "2026-04-20T14:00:00.000Z",
          client: TEST_CLIENT,
          idempotencyKey: "idem-003",
        }),
      );

      expect(result.id).toBe("booking-uuid-1");
    });
  });

  // -------------------------------------------------------------------------
  // Idempotency dedup
  // -------------------------------------------------------------------------

  describe("createBooking idempotency", () => {
    it("replays the existing booking for a duplicate idempotency key without a second insert", async () => {
      // Pre-lookup hits → loadBookingById (4 selects) → no insert at all
      const mockDb = createSequencedMockDb([
        [{ ...BOOKING_ROW, idempotencyKey: "idem-dup" }], // pre-lookup hit
        [BOOKING_ROW], // loadBookingById: booking
        [SERVICE_ROW], // loadBookingById: service
        [CLIENT_ROW], // loadBookingById: client
        [PRACTITIONER_ROW], // loadBookingById: practitioner
      ]);

      const adapter = createAdapter({ getDb: async () => mockDb });
      const result = await Effect.runPromise(
        adapter.createBooking({
          serviceId: "svc-uuid-1",
          datetime: "2026-04-20T14:00:00.000Z",
          client: TEST_CLIENT,
          idempotencyKey: "idem-dup",
        }),
      );

      expect(result.id).toBe("booking-uuid-1");
      expect(result.confirmationCode).toBe("ABC123");
      expect(mockDb.insert).not.toHaveBeenCalled();
    });

    it("recovers from a unique-violation race by replaying the winning row", async () => {
      // Pre-lookup misses, insert hits the (schema-package-owned) unique
      // index, replay lookup finds the row the concurrent request inserted.
      let selectCall = 0;
      const selectSequence = [
        [], // 1. idempotency pre-lookup (miss — race window)
        [SERVICE_ROW], // 2. resolveService
        [CLIENT_ROW], // 3. findOrCreateClient email lookup
        [PRACTITIONER_ROW], // 4. getDefaultPractitioner
        [], // 5. write gate: occupied bookings
        [], // 6. write gate: occupied time blocks
        [], // 7. write gate: active soft holds
        [{ ...BOOKING_ROW, idempotencyKey: "idem-race" }], // 8. replay lookup
        [BOOKING_ROW], // 9. loadBookingById: booking
        [SERVICE_ROW], // 10. loadBookingById: service
        [CLIENT_ROW], // 11. loadBookingById: client
        [PRACTITIONER_ROW], // 12. loadBookingById: practitioner
      ];
      const makeSelectChain = () => {
        const rows = selectSequence[selectCall] ?? [];
        selectCall++;
        const terminals = selectTerminal(rows);
        return {
          where: vi.fn().mockReturnValue(terminals),
          orderBy: terminals.orderBy,
          limit: terminals.limit,
        };
      };
      const uniqueViolation = Object.assign(
        new Error(
          'duplicate key value violates unique constraint "bookings_idempotency_key_key"',
        ),
        { code: "23505" },
      );
      const mockDb = {
        select: vi.fn().mockImplementation(() => ({
          from: vi.fn().mockImplementation(makeSelectChain),
        })),
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockRejectedValue(uniqueViolation),
          }),
        }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(undefined),
          }),
        }),
      };

      const adapter = createAdapter({ getDb: async () => mockDb });
      const result = await Effect.runPromise(
        adapter.createBooking({
          serviceId: "svc-uuid-1",
          datetime: "2026-04-20T14:00:00.000Z",
          client: TEST_CLIENT,
          idempotencyKey: "idem-race",
        }),
      );

      expect(result.id).toBe("booking-uuid-1");
      expect(mockDb.insert).toHaveBeenCalledTimes(1);
    });

    it("rethrows unique violations that cannot be replayed", async () => {
      // Same race shape, but the replay lookup also misses (e.g. the
      // violation came from a different constraint).
      let selectCall = 0;
      const selectSequence = [
        [], // pre-lookup miss
        [SERVICE_ROW],
        [CLIENT_ROW],
        [PRACTITIONER_ROW],
        [], // write gate: occupied bookings
        [], // write gate: occupied time blocks
        [], // write gate: active soft holds
        [], // replay lookup also misses
      ];
      const makeSelectChain = () => {
        const rows = selectSequence[selectCall] ?? [];
        selectCall++;
        const terminals = selectTerminal(rows);
        return {
          where: vi.fn().mockReturnValue(terminals),
          orderBy: terminals.orderBy,
          limit: terminals.limit,
        };
      };
      const mockDb = {
        select: vi.fn().mockImplementation(() => ({
          from: vi.fn().mockImplementation(makeSelectChain),
        })),
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockRejectedValue(
              Object.assign(new Error("duplicate key value"), {
                code: "23505",
              }),
            ),
          }),
        }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(undefined),
          }),
        }),
      };

      const adapter = createAdapter({ getDb: async () => mockDb });
      const error = await Effect.runPromise(
        Effect.flip(
          adapter.createBooking({
            serviceId: "svc-uuid-1",
            datetime: "2026-04-20T14:00:00.000Z",
            client: TEST_CLIENT,
            idempotencyKey: "idem-orphan",
          }),
        ),
      );

      expect(error._tag).toBe("InfrastructureError");
    });

    it("surfaces the original unique violation when the replay lookup itself fails", async () => {
      // Insert hits the unique index, then the recovery lookup also rejects
      // (e.g. transient connection error). The root-cause unique violation
      // must survive, not the secondary lookup failure.
      let selectCall = 0;
      const replayLookupFailure = new Error("connection terminated");
      const selectSequence: (Record<string, unknown>[] | Error)[] = [
        [], // pre-lookup miss
        [SERVICE_ROW],
        [CLIENT_ROW],
        [PRACTITIONER_ROW],
        [], // write gate: occupied bookings
        [], // write gate: occupied time blocks
        [], // write gate: active soft holds
        replayLookupFailure, // replay lookup rejects
      ];
      const makeSelectChain = () => {
        const entry = selectSequence[selectCall] ?? [];
        selectCall++;
        const terminals = selectTerminal(entry);
        return {
          where: vi.fn().mockReturnValue(terminals),
          orderBy: terminals.orderBy,
          limit: terminals.limit,
        };
      };
      const uniqueViolation = Object.assign(
        new Error(
          'duplicate key value violates unique constraint "bookings_idempotency_key_key"',
        ),
        { code: "23505" },
      );
      const mockDb = {
        select: vi.fn().mockImplementation(() => ({
          from: vi.fn().mockImplementation(makeSelectChain),
        })),
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockRejectedValue(uniqueViolation),
          }),
        }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(undefined),
          }),
        }),
      };

      const adapter = createAdapter({ getDb: async () => mockDb });
      const error = await Effect.runPromise(
        Effect.flip(
          adapter.createBooking({
            serviceId: "svc-uuid-1",
            datetime: "2026-04-20T14:00:00.000Z",
            client: TEST_CLIENT,
            idempotencyKey: "idem-double-fault",
          }),
        ),
      );

      expect(error._tag).toBe("InfrastructureError");
      expect(error).toMatchObject({
        message: expect.stringContaining("duplicate key value"),
      });
      expect((error as { message: string }).message).not.toContain(
        "connection terminated",
      );
    });

    it("treats an empty-string idempotency key as absent and persists null", async () => {
      // "" skips the pre-insert lookup entirely (first select is
      // resolveService) and is normalized to null on insert so it can never
      // occupy the unique index slot.
      let selectCall = 0;
      const selectSequence = [
        [SERVICE_ROW], // resolveService (no pre-lookup before it)
        [CLIENT_ROW], // findOrCreateClient email lookup
        [PRACTITIONER_ROW], // getDefaultPractitioner
        [], // write gate: occupied bookings
        [], // write gate: occupied time blocks
        [], // write gate: active soft holds
      ];
      const makeSelectChain = () => {
        const rows = selectSequence[selectCall] ?? [];
        selectCall++;
        const terminals = selectTerminal(rows);
        return {
          where: vi.fn().mockReturnValue(terminals),
          orderBy: terminals.orderBy,
          limit: terminals.limit,
        };
      };
      const insertedValues: Record<string, unknown>[] = [];
      const mockDb = {
        select: vi.fn().mockImplementation(() => ({
          from: vi.fn().mockImplementation(makeSelectChain),
        })),
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockImplementation((v: Record<string, unknown>) => {
            insertedValues.push(v);
            return { returning: vi.fn().mockResolvedValue([BOOKING_ROW]) };
          }),
        }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(undefined),
          }),
        }),
      };

      const adapter = createAdapter({ getDb: async () => mockDb });
      const result = await Effect.runPromise(
        adapter.createBooking({
          serviceId: "svc-uuid-1",
          datetime: "2026-04-20T14:00:00.000Z",
          client: TEST_CLIENT,
          idempotencyKey: "",
        }),
      );

      expect(result.id).toBe("booking-uuid-1");
      // Pre-insert dedup lookup skipped: 3 pipeline selects (service, client,
      // practitioner) plus the 3 write-gate occupied selects ran, but no
      // idempotency pre-lookup.
      expect(mockDb.select).toHaveBeenCalledTimes(6);
      expect(insertedValues[0].idempotencyKey).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Confirmation code prefix threading
  // -------------------------------------------------------------------------

  describe("confirmation code prefix", () => {
    const createCapturingDb = () => {
      let selectCall = 0;
      const selectSequence = [
        [], // idempotency pre-lookup
        [SERVICE_ROW], // resolveService
        [CLIENT_ROW], // findOrCreateClient
        [PRACTITIONER_ROW], // getDefaultPractitioner
        [], // write gate: occupied bookings
        [], // write gate: occupied time blocks
        [], // write gate: active soft holds
      ];
      const makeSelectChain = () => {
        const rows = selectSequence[selectCall] ?? [];
        selectCall++;
        const terminals = selectTerminal(rows);
        return {
          where: vi.fn().mockReturnValue(terminals),
          orderBy: terminals.orderBy,
          limit: terminals.limit,
        };
      };
      const insertedValues: Record<string, unknown>[] = [];
      return {
        insertedValues,
        db: {
          select: vi.fn().mockImplementation(() => ({
            from: vi.fn().mockImplementation(makeSelectChain),
          })),
          insert: vi.fn().mockReturnValue({
            values: vi.fn().mockImplementation((v: Record<string, unknown>) => {
              insertedValues.push(v);
              return { returning: vi.fn().mockResolvedValue([BOOKING_ROW]) };
            }),
          }),
          update: vi.fn().mockReturnValue({
            set: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue(undefined),
            }),
          }),
        },
      };
    };

    const bookingRequest = {
      serviceId: "svc-uuid-1",
      datetime: "2026-04-20T14:00:00.000Z",
      client: TEST_CLIENT,
      idempotencyKey: "idem-prefix",
    };

    it("generates confirmation codes with the neutral BK prefix by default", async () => {
      const { db, insertedValues } = createCapturingDb();
      const adapter = createAdapter({ getDb: async () => db });

      await Effect.runPromise(adapter.createBooking(bookingRequest));

      expect(insertedValues[0].confirmationCode).toMatch(/^BK-[A-Z2-9]{6}$/);
    });

    it("threads confirmationCodePrefix from config into generated codes", async () => {
      const { db, insertedValues } = createCapturingDb();
      const adapter = createAdapter({
        getDb: async () => db,
        confirmationCodePrefix: "MI",
      });

      await Effect.runPromise(adapter.createBooking(bookingRequest));

      expect(insertedValues[0].confirmationCode).toMatch(/^MI-[A-Z2-9]{6}$/);
    });

    it("persists the idempotency key on insert", async () => {
      const { db, insertedValues } = createCapturingDb();
      const adapter = createAdapter({ getDb: async () => db });

      await Effect.runPromise(adapter.createBooking(bookingRequest));

      expect(insertedValues[0].idempotencyKey).toBe("idem-prefix");
    });
  });

  // -------------------------------------------------------------------------
  // Typed error mapping
  // -------------------------------------------------------------------------

  describe("typed error mapping", () => {
    it("maps unknown service in getService to ValidationError(serviceId)", async () => {
      const mockDb = createMockDb({ select: [] });
      mockDb._terminals.limit.mockResolvedValue([]);
      const adapter = createAdapter({ getDb: async () => mockDb });

      const error = await Effect.runPromise(
        Effect.flip(adapter.getService("nonexistent")),
      );

      expect(error._tag).toBe("ValidationError");
      expect(error).toMatchObject({
        field: "serviceId",
        message: "Service nonexistent not found",
        value: "nonexistent",
      });
    });

    it("maps unknown provider in getProvider to ValidationError(providerId)", async () => {
      const mockDb = createMockDb({ select: [] });
      mockDb._terminals.limit.mockResolvedValue([]);
      const adapter = createAdapter({ getDb: async () => mockDb });

      const error = await Effect.runPromise(
        Effect.flip(adapter.getProvider("nonexistent")),
      );

      expect(error._tag).toBe("ValidationError");
      expect(error).toMatchObject({
        field: "providerId",
        message: "Provider nonexistent not found",
      });
    });

    it("maps unknown booking in getBooking to ValidationError(bookingId)", async () => {
      const mockDb = createSequencedMockDb([[]]);
      const adapter = createAdapter({ getDb: async () => mockDb });

      const error = await Effect.runPromise(
        Effect.flip(adapter.getBooking("nonexistent")),
      );

      expect(error._tag).toBe("ValidationError");
      expect(error).toMatchObject({
        field: "bookingId",
        message: "Booking nonexistent not found",
      });
    });

    it("maps unknown booking in rescheduleBooking to ValidationError(bookingId)", async () => {
      const mockDb = createSequencedMockDb([[]]);
      const adapter = createAdapter({ getDb: async () => mockDb });

      const error = await Effect.runPromise(
        Effect.flip(
          adapter.rescheduleBooking("nonexistent", "2026-04-21T10:00:00.000Z"),
        ),
      );

      expect(error._tag).toBe("ValidationError");
      expect(error).toMatchObject({ field: "bookingId" });
    });

    it("maps unknown service in createBooking to ValidationError(serviceId)", async () => {
      const mockDb = createSequencedMockDb([
        [], // idempotency pre-lookup
        [], // resolveService miss
      ]);
      const adapter = createAdapter({ getDb: async () => mockDb });

      const error = await Effect.runPromise(
        Effect.flip(
          adapter.createBooking({
            serviceId: "nonexistent",
            datetime: "2026-04-20T14:00:00.000Z",
            client: TEST_CLIENT,
            idempotencyKey: "idem-missing-svc",
          }),
        ),
      );

      expect(error._tag).toBe("ValidationError");
      expect(error).toMatchObject({ field: "serviceId" });
    });

    it("keeps InfrastructureError(UNKNOWN) for unrecognized failures", async () => {
      const adapter = createAdapter({
        getDb: async () => {
          throw new Error("ECONNREFUSED");
        },
      });

      const error = await Effect.runPromise(Effect.flip(adapter.getServices()));

      expect(error._tag).toBe("InfrastructureError");
      expect(error).toMatchObject({ code: "UNKNOWN", message: "ECONNREFUSED" });
    });
  });

  // -------------------------------------------------------------------------
  // Default practitioner handle requirement (no built-in fallback)
  // -------------------------------------------------------------------------

  describe("default practitioner handle requirement", () => {
    it("fails getProviders with ValidationError when no handle is configured", async () => {
      const mockDb = createMockDb({ select: [PRACTITIONER_ROW] });
      const adapter = createHomegrownAdapter({
        schemas: testSchemas,
        getDb: async () => mockDb,
      });

      const error = await Effect.runPromise(
        Effect.flip(adapter.getProviders()),
      );

      expect(error._tag).toBe("ValidationError");
      expect(error).toMatchObject({ field: "defaultPractitionerHandle" });
      expect((error as { message: string }).message).toContain(
        "defaultPractitionerHandle",
      );
    });

    it("fails createBooking with ValidationError when no handle is configured", async () => {
      const mockDb = createSequencedMockDb([
        [], // idempotency pre-lookup
        [SERVICE_ROW], // resolveService
        [CLIENT_ROW], // findOrCreateClient
      ]);
      const adapter = createHomegrownAdapter({
        schemas: testSchemas,
        getDb: async () => mockDb,
      });

      const error = await Effect.runPromise(
        Effect.flip(
          adapter.createBooking({
            serviceId: "svc-uuid-1",
            datetime: "2026-04-20T14:00:00.000Z",
            client: TEST_CLIENT,
            idempotencyKey: "idem-no-handle",
          }),
        ),
      );

      expect(error._tag).toBe("ValidationError");
      expect(error).toMatchObject({ field: "defaultPractitionerHandle" });
    });
  });

  describe("getBooking", () => {
    it("joins booking, service, client, and practitioner data", async () => {
      // getBooking does 4 sequential selects:
      //   1. booking by ID
      //   2. service by booking.serviceId
      //   3. client by booking.clientId
      //   4. practitioner by booking.practitionerId (conditional)
      const mockDb = createSequencedMockDb([
        [BOOKING_ROW], // booking
        [SERVICE_ROW], // service
        [CLIENT_ROW], // client
        [PRACTITIONER_ROW], // practitioner
      ]);

      const adapter = createAdapter({ getDb: async () => mockDb });
      const result = await Effect.runPromise(
        adapter.getBooking("booking-uuid-1"),
      );

      expect(result.id).toBe("booking-uuid-1");
      expect(result.serviceName).toBe("Deep Tissue Massage");
      expect(result.providerName).toBe("Alex Rivera");
      expect(result.client.firstName).toBe("Alice");
      expect(result.client.email).toBe("alice@example.com");
      expect(result.duration).toBe(60);
      expect(result.price).toBe(9500);
      expect(result.currency).toBe("USD");
    });

    it("fails when booking not found", async () => {
      const mockDb = createSequencedMockDb([
        [], // booking not found
      ]);

      const adapter = createAdapter({ getDb: async () => mockDb });
      const exit = await Effect.runPromiseExit(
        adapter.getBooking("nonexistent"),
      );

      expect(exit._tag).toBe("Failure");
    });

    it("handles missing service gracefully", async () => {
      const mockDb = createSequencedMockDb([
        [BOOKING_ROW], // booking exists
        [], // service not found
        [CLIENT_ROW], // client
      ]);

      const adapter = createAdapter({ getDb: async () => mockDb });
      const result = await Effect.runPromise(
        adapter.getBooking("booking-uuid-1"),
      );

      // Falls back to 'Unknown' for service name, 'USD' for currency
      expect(result.serviceName).toBe("Unknown");
      expect(result.currency).toBe("USD");
    });
  });

  describe("rescheduleBooking", () => {
    it("updates datetime and returns refreshed booking", async () => {
      // rescheduleBooking:
      //   1. select existing booking
      //   2. update with new datetime/endTime
      //   3. calls getBooking internally (4 more selects)
      const mockDb = createSequencedMockDb([
        [BOOKING_ROW], // 1. select existing
        [], // write gate: occupied bookings
        [], // write gate: occupied time blocks
        [], // write gate: active soft holds
        // getBooking selects (called via adapter.getBooking):
        [
          {
            ...BOOKING_ROW,
            datetime: "2026-04-21T10:00:00.000Z",
            endTime: "2026-04-21T11:00:00.000Z",
          },
        ],
        [SERVICE_ROW],
        [CLIENT_ROW],
        [PRACTITIONER_ROW],
      ]);

      const adapter = createAdapter({ getDb: async () => mockDb });
      const result = await Effect.runPromise(
        adapter.rescheduleBooking("booking-uuid-1", "2026-04-21T10:00:00.000Z"),
      );

      expect(result.id).toBe("booking-uuid-1");
      expect(result.datetime).toBe("2026-04-21T10:00:00.000Z");
    });

    it("fails when booking not found", async () => {
      const mockDb = createSequencedMockDb([
        [], // existing booking not found
      ]);

      const adapter = createAdapter({ getDb: async () => mockDb });
      const exit = await Effect.runPromiseExit(
        adapter.rescheduleBooking("nonexistent", "2026-04-21T10:00:00.000Z"),
      );

      expect(exit._tag).toBe("Failure");
    });

    it("keeps read, update, and refreshed fetch in one scoped executor call", async () => {
      const mockDb = createSequencedMockDb([
        [BOOKING_ROW],
        [], // write gate: occupied bookings
        [], // write gate: occupied time blocks
        [], // write gate: active soft holds
        [
          {
            ...BOOKING_ROW,
            datetime: "2026-04-21T10:00:00.000Z",
            endTime: "2026-04-21T11:00:00.000Z",
          },
        ],
        [SERVICE_ROW],
        [CLIENT_ROW],
        [PRACTITIONER_ROW],
      ]);
      const withDb = vi.fn(async (fn) => fn(mockDb));

      const adapter = createAdapter({ withDb });
      const result = await Effect.runPromise(
        adapter.rescheduleBooking("booking-uuid-1", "2026-04-21T10:00:00.000Z"),
      );

      expect(result.datetime).toBe("2026-04-21T10:00:00.000Z");
      expect(withDb).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // Write-time slot validation (double-booking gate)
  // -------------------------------------------------------------------------

  describe("write-time slot validation", () => {
    // A booking that overlaps the 60-minute slot starting 2026-04-20T14:00Z.
    const OVERLAPPING_BOOKING = {
      datetime: "2026-04-20T14:30:00.000Z",
      endTime: "2026-04-20T15:30:00.000Z",
    };

    /**
     * Build a mock DB for a createBooking call whose write gate sees the given
     * occupied-bookings rows. Records where-conditions and inserted values so
     * tests can assert both the rejection and the query the gate issued.
     */
    const createGateMockDb = (occupiedBookings: MockRow[]) => {
      let selectCall = 0;
      const selectSequence: MockRow[][] = [
        [], // idempotency pre-lookup
        [SERVICE_ROW], // resolveService
        [CLIENT_ROW], // findOrCreateClient email lookup
        [PRACTITIONER_ROW], // getDefaultPractitioner
        occupiedBookings, // write gate: occupied bookings
        [], // write gate: occupied time blocks
        [], // write gate: active soft holds
      ];
      const whereConds: unknown[] = [];
      const insertedValues: MockRow[] = [];
      const makeSelectChain = () => {
        const rows = selectSequence[selectCall] ?? [];
        selectCall++;
        const terminals = selectTerminal(rows);
        return {
          where: vi.fn().mockImplementation((cond: unknown) => {
            whereConds.push(cond);
            return terminals;
          }),
          orderBy: terminals.orderBy,
          limit: terminals.limit,
        };
      };
      const db = {
        select: vi.fn().mockImplementation(() => ({
          from: vi.fn().mockImplementation(makeSelectChain),
        })),
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockImplementation((v: MockRow) => {
            insertedValues.push(v);
            return { returning: vi.fn().mockResolvedValue([BOOKING_ROW]) };
          }),
        }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(undefined),
          }),
        }),
      };
      return { db, whereConds, insertedValues };
    };

    const bookingRequest = {
      serviceId: "svc-uuid-1",
      datetime: "2026-04-20T14:00:00.000Z",
      client: TEST_CLIENT,
      idempotencyKey: "idem-overlap",
    };

    it("rejects createBooking with SLOT_TAKEN when the slot overlaps an existing booking", async () => {
      const { db, insertedValues } = createGateMockDb([OVERLAPPING_BOOKING]);
      const adapter = createAdapter({ getDb: async () => db });

      const error = await Effect.runPromise(
        Effect.flip(adapter.createBooking(bookingRequest)),
      );

      expect(error._tag).toBe("ReservationError");
      expect(error).toMatchObject({
        code: "SLOT_TAKEN",
        datetime: "2026-04-20T14:00:00.000Z",
      });
      // The insert never ran: the gate rejected before the write.
      expect(insertedValues).toHaveLength(0);
      expect(db.insert).not.toHaveBeenCalled();
    });

    it("allows createBooking when the occupied set does not overlap the slot", async () => {
      // A booking that ends exactly when the slot starts is adjacent, not
      // overlapping, and must not block the write.
      const adjacent = {
        datetime: "2026-04-20T13:00:00.000Z",
        endTime: "2026-04-20T14:00:00.000Z",
      };
      const { db } = createGateMockDb([adjacent]);
      const adapter = createAdapter({ getDb: async () => db });

      const result = await Effect.runPromise(
        adapter.createBooking(bookingRequest),
      );

      expect(result.id).toBe("booking-uuid-1");
      expect(db.insert).toHaveBeenCalledOnce();
    });

    it("queries the occupied set with tz-aware ET day bounds so evening bookings survive the UTC boundary", async () => {
      const { db, whereConds } = createGateMockDb([]);
      const adapter = createAdapter({ getDb: async () => db });

      await Effect.runPromise(adapter.createBooking(bookingRequest));

      // The occupied-bookings query is the first where-condition carrying a
      // datetime upper bound. Its bounds must be ET local midnight
      // (EDT = UTC-4 on 2026-04-20), not the naive UTC-day bounds.
      const cond = whereConds.find(
        (c: any) =>
          c?.op === "and" &&
          Array.isArray(c.args) &&
          c.args.some((a: any) => a?.col === "datetime" && a?.op === "lt"),
      ) as { args: Array<{ col: string; op: string; val: string }> };
      expect(cond).toBeDefined();

      const upperBound = cond.args.find(
        (a) => a.col === "datetime" && a.op === "lt",
      )?.val;
      const lowerBound = cond.args.find(
        (a) => a.col === "endTime" && a.op === "gt",
      )?.val;

      expect(lowerBound).toBe("2026-04-20T04:00:00.000Z");
      expect(upperBound).toBe("2026-04-21T04:00:00.000Z");
      // An 8pm ET booking (stored 2026-04-21T00:00Z) falls inside these bounds
      // but would have been excluded by the old 2026-04-20T23:59:59Z bound.
      expect(new Date("2026-04-21T00:00:00.000Z").getTime()).toBeLessThan(
        new Date(upperBound as string).getTime(),
      );
    });

    it("queries the previous local day when the configured buffer crosses midnight", async () => {
      const { db, whereConds } = createGateMockDb([]);
      const adapter = createAdapter({
        getDb: async () => db,
        bufferMinutes: 30,
      });

      await Effect.runPromise(
        adapter.createBooking({
          ...bookingRequest,
          // 00:10 EDT on April 21; the 30-minute buffer starts at 23:40 EDT
          // on April 20, so occupied rows from the prior local day matter.
          datetime: "2026-04-21T04:10:00.000Z",
        }),
      );

      const cond = whereConds.find(
        (c: any) =>
          c?.op === "and" &&
          Array.isArray(c.args) &&
          c.args.some((a: any) => a?.col === "datetime" && a?.op === "lt"),
      ) as { args: Array<{ col: string; op: string; val: string }> };
      const lowerBound = cond.args.find(
        (a) => a.col === "endTime" && a.op === "gt",
      )?.val;

      expect(lowerBound).toBe("2026-04-20T04:00:00.000Z");
    });

    it("queries the next local day when the configured buffer crosses midnight", async () => {
      const { db, whereConds } = createGateMockDb([]);
      const adapter = createAdapter({
        getDb: async () => db,
        bufferMinutes: 30,
      });

      await Effect.runPromise(
        adapter.createBooking({
          ...bookingRequest,
          // 22:50-23:50 EDT on April 21; the 30-minute buffer ends at 00:20
          // EDT on April 22, so occupied rows from the next local day matter.
          datetime: "2026-04-22T02:50:00.000Z",
        }),
      );

      const cond = whereConds.find(
        (c: any) =>
          c?.op === "and" &&
          Array.isArray(c.args) &&
          c.args.some((a: any) => a?.col === "datetime" && a?.op === "lt"),
      ) as { args: Array<{ col: string; op: string; val: string }> };
      const upperBound = cond.args.find(
        (a) => a.col === "datetime" && a.op === "lt",
      )?.val;

      expect(upperBound).toBe("2026-04-23T04:00:00.000Z");
    });

    it("excludes a soft hold only when its id and slot match the booking", async () => {
      const { db, whereConds } = createGateMockDb([]);
      const adapter = createAdapter({ getDb: async () => db });

      await Effect.runPromise(
        adapter.createBooking({
          ...bookingRequest,
          softHoldId: "owned-hold-id",
        }),
      );

      const holdQuery = whereConds.find(
        (c: any) =>
          c?.op === "and" &&
          Array.isArray(c.args) &&
          c.args.some((a: any) => a?.op === "isNull"),
      ) as { args: Array<{ op: string; arg?: { args?: unknown[] } }> };
      const exclusion = holdQuery.args.find((arg) => arg.op === "not");

      expect(exclusion?.arg).toEqual({
        op: "and",
        args: [
          { op: "eq", col: "id", val: "owned-hold-id" },
          {
            op: "eq",
            col: "datetime",
            val: "2026-04-20T14:00:00.000Z",
          },
          { op: "eq", col: "duration", val: 60 },
        ],
      });
    });

    it("rejects rescheduleBooking with SLOT_TAKEN when the new slot overlaps another booking", async () => {
      // A different booking occupies the target slot. The reschedule gate
      // excludes the booking being moved, so this conflict is a real one.
      const otherBooking = {
        datetime: "2026-04-21T10:30:00.000Z",
        endTime: "2026-04-21T11:30:00.000Z",
      };
      const mockDb = createSequencedMockDb([
        [BOOKING_ROW], // select existing (status confirmed)
        [otherBooking], // write gate: occupied bookings (conflict)
        [], // write gate: occupied time blocks
        [], // write gate: active soft holds
      ]);
      const adapter = createAdapter({ getDb: async () => mockDb });

      const error = await Effect.runPromise(
        Effect.flip(
          adapter.rescheduleBooking(
            "booking-uuid-1",
            "2026-04-21T10:00:00.000Z",
          ),
        ),
      );

      expect(error._tag).toBe("ReservationError");
      expect(error).toMatchObject({ code: "SLOT_TAKEN" });
      expect(mockDb.update).not.toHaveBeenCalled();
    });

    it("rejects rescheduleBooking of a cancelled booking with a status ValidationError", async () => {
      const mockDb = createSequencedMockDb([
        [{ ...BOOKING_ROW, status: "cancelled" }],
      ]);
      const adapter = createAdapter({ getDb: async () => mockDb });

      const error = await Effect.runPromise(
        Effect.flip(
          adapter.rescheduleBooking(
            "booking-uuid-1",
            "2026-04-21T10:00:00.000Z",
          ),
        ),
      );

      expect(error._tag).toBe("ValidationError");
      expect(error).toMatchObject({ field: "status", value: "cancelled" });
      // Terminal-status check short-circuits before any occupied lookup or write.
      expect(mockDb.update).not.toHaveBeenCalled();
    });

    it("rejects rescheduleBooking of a completed booking with a status ValidationError", async () => {
      const mockDb = createSequencedMockDb([
        [{ ...BOOKING_ROW, status: "completed" }],
      ]);
      const adapter = createAdapter({ getDb: async () => mockDb });

      const error = await Effect.runPromise(
        Effect.flip(
          adapter.rescheduleBooking(
            "booking-uuid-1",
            "2026-04-21T10:00:00.000Z",
          ),
        ),
      );

      expect(error._tag).toBe("ValidationError");
      expect(error).toMatchObject({ field: "status", value: "completed" });
      expect(mockDb.update).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Effect error wrapping
  // -------------------------------------------------------------------------

  describe("Effect error wrapping", () => {
    it("wraps DB connection errors as InfrastructureError", async () => {
      const adapter = createAdapter({
        getDb: async () => {
          throw new Error("ECONNREFUSED");
        },
      });

      const exit = await Effect.runPromiseExit(adapter.getServices());
      expect(exit._tag).toBe("Failure");
    });

    it("wraps non-Error throws as InfrastructureError with UNKNOWN code", async () => {
      const adapter = createAdapter({
        getDb: async () => {
          throw "string error";
        },
      });

      const exit = await Effect.runPromiseExit(adapter.getServices());
      expect(exit._tag).toBe("Failure");
    });
  });
});
