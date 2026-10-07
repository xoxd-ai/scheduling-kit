/**
 * Acuity Scheduling Adapter
 * Implements SchedulingAdapter for Acuity's REST API
 */

import { Effect, pipe } from 'effect';
import type {
  SchedulingResult,
  Service,
  Provider,
  TimeSlot,
  AvailableDate,
  Booking,
  BookingRequest,
  SlotSoftHold,
  ClientInfo,
} from '../core/types.js';
import { Errors } from '../core/types.js';
import { formatPaymentRef } from '../core/payment-ref.js';
import { fromPromise, withRetry, withTimeout } from '../core/utils.js';
import type { SchedulingAdapter, AcuityAdapterConfig } from './types.js';

// =============================================================================
// ACUITY API TYPES
// =============================================================================

interface AcuityAppointmentType {
  id: number;
  name: string;
  description: string;
  duration: number;
  price: string;
  category: string;
  color: string;
  active: boolean;
  calendarIDs: number[];
}

interface AcuityCalendar {
  id: number;
  name: string;
  email: string;
  description: string;
  image: string;
  timezone: string;
}

interface AcuityAvailableDate {
  date: string;
}

interface AcuityAvailableTime {
  time: string;
  slotsAvailable: number;
}

interface AcuityBlock {
  id: number;
  start: string;
  end: string;
  notes: string;
  calendarID: number;
}

interface AcuityAppointment {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  datetime: string;
  endTime: string;
  duration: number;
  price: string;
  priceSold: string;
  paid: string;
  amountPaid: string;
  type: string;
  appointmentTypeID: number;
  calendarID: number;
  calendar: string;
  confirmationPage: string;
  notes: string;
  forms: unknown[];
  labels: unknown[];
}

// =============================================================================
// ACUITY ADAPTER IMPLEMENTATION
// =============================================================================

export const createAcuityAdapter = (config: AcuityAdapterConfig): SchedulingAdapter => {
  const baseUrl = config.baseUrl ?? 'https://acuityscheduling.com/api/v1';
  const auth = Buffer.from(`${config.userId}:${config.apiKey}`).toString('base64');

  // ---------------------------------------------------------------------------
  // HTTP Client
  // ---------------------------------------------------------------------------

  const request = <T>(
    method: string,
    endpoint: string,
    body?: unknown
  ): SchedulingResult<T> =>
    pipe(
      fromPromise(
        async () => {
          const response = await fetch(`${baseUrl}${endpoint}`, {
            method,
            headers: {
              Authorization: `Basic ${auth}`,
              'Content-Type': 'application/json',
            },
            body: body ? JSON.stringify(body) : undefined,
          });

          if (!response.ok) {
            const errorBody = await response.text();
            throw new Error(`${response.status}: ${errorBody}`);
          }

          return response.json() as Promise<T>;
        },
        (e) => {
          const message = e instanceof Error ? e.message : String(e);
          const statusMatch = message.match(/^(\d+):/);
          const statusCode = statusMatch ? parseInt(statusMatch[1], 10) : undefined;

          return Errors.acuity(
            statusCode === 429 ? 'RATE_LIMITED' : 'API_ERROR',
            message,
            statusCode,
            endpoint
          );
        }
      ),
      withRetry({
        maxAttempts: 3,
        retryOn: (e) => e._tag === 'AcuityError' && e.statusCode === 429,
      }),
      withTimeout(30000)
    );

  const get = <T>(endpoint: string) => request<T>('GET', endpoint);
  const post = <T>(endpoint: string, body: unknown) => request<T>('POST', endpoint, body);
  const del = <T>(endpoint: string) => request<T>('DELETE', endpoint);

  // ---------------------------------------------------------------------------
  // Transformers
  // ---------------------------------------------------------------------------

  const toService = (apt: AcuityAppointmentType): Service => ({
    id: String(apt.id),
    name: apt.name,
    description: apt.description,
    duration: apt.duration,
    price: Math.round(parseFloat(apt.price || '0') * 100),
    currency: 'USD',
    category: apt.category,
    color: apt.color,
    active: apt.active,
  });

  const toProvider = (cal: AcuityCalendar): Provider => ({
    id: String(cal.id),
    name: cal.name,
    email: cal.email,
    description: cal.description,
    image: cal.image,
    timezone: cal.timezone,
  });

  const toBooking = (apt: AcuityAppointment): Booking => ({
    id: String(apt.id),
    serviceId: String(apt.appointmentTypeID),
    serviceName: apt.type,
    providerId: String(apt.calendarID),
    providerName: apt.calendar,
    datetime: apt.datetime,
    endTime: apt.endTime,
    duration: apt.duration,
    price: Math.round(parseFloat(apt.priceSold || apt.price || '0') * 100),
    currency: 'USD',
    client: {
      firstName: apt.firstName,
      lastName: apt.lastName,
      email: apt.email,
      phone: apt.phone,
    },
    status: 'confirmed',
    confirmationCode: String(apt.id),
    paymentStatus: apt.paid === 'yes' ? 'paid' : 'pending',
    paymentRef: apt.notes,
    createdAt: new Date().toISOString(),
  });

  // ---------------------------------------------------------------------------
  // Interface Implementation
  // ---------------------------------------------------------------------------

  return {
    name: 'acuity',

    // Services
    getServices: () =>
      Effect.map(
        get<AcuityAppointmentType[]>('/appointment-types'),
        (types) => types.filter((t) => t.active).map(toService)
      ),

    getService: (serviceId) =>
      Effect.flatMap(
        get<AcuityAppointmentType[]>('/appointment-types'),
        (types) => {
          const found = types.find((t) => String(t.id) === serviceId);
          return found
            ? Effect.succeed(toService(found))
            : Effect.fail(Errors.acuity('NOT_FOUND', `Service ${serviceId} not found`));
        }
      ),

    // Providers
    getProviders: () =>
      Effect.map(
        get<AcuityCalendar[]>('/calendars'),
        (cals) => cals.map(toProvider)
      ),

    getProvider: (providerId) =>
      Effect.flatMap(
        get<AcuityCalendar[]>('/calendars'),
        (cals) => {
          const found = cals.find((c) => String(c.id) === providerId);
          return found
            ? Effect.succeed(toProvider(found))
            : Effect.fail(Errors.acuity('NOT_FOUND', `Provider ${providerId} not found`));
        }
      ),

    getProvidersForService: (serviceId) =>
      Effect.gen(function* () {
        const types = yield* get<AcuityAppointmentType[]>('/appointment-types');
        const calendars = yield* get<AcuityCalendar[]>('/calendars');
        const serviceType = types.find((t) => String(t.id) === serviceId);
        if (!serviceType) return [];
        return calendars
          .filter((c) => serviceType.calendarIDs.includes(c.id))
          .map(toProvider);
      }),

    // Availability
    getAvailableDates: ({ serviceId, providerId, startDate, endDate }) => {
      const params = new URLSearchParams({
        appointmentTypeID: serviceId,
        month: startDate.slice(0, 7),
      });
      if (providerId) params.set('calendarID', providerId);

      return Effect.map(
        get<AcuityAvailableDate[]>(`/availability/dates?${params}`),
        (dates) =>
          dates
            .filter((d) => d.date >= startDate && d.date <= endDate)
            .map((d) => ({ date: d.date, slots: 1 }))
      );
    },

    getAvailableSlots: ({ serviceId, providerId, date }) => {
      const params = new URLSearchParams({
        appointmentTypeID: serviceId,
        date,
      });
      if (providerId) params.set('calendarID', providerId);

      return Effect.map(
        get<AcuityAvailableTime[]>(`/availability/times?${params}`),
        (times) =>
          times.map((t) => ({
            datetime: t.time,
            available: t.slotsAvailable > 0,
          }))
      );
    },

    checkSlotAvailability: ({ serviceId, providerId, datetime }) => {
      const params = new URLSearchParams({
        appointmentTypeID: serviceId,
        datetime,
      });
      if (providerId) params.set('calendarID', providerId);

      return pipe(
        Effect.map(
          get<{ valid: boolean }>(`/availability/check-times?${params}`),
          (result) => result.valid
        ),
        Effect.catch(() => Effect.succeed(false)) // Treat errors as unavailable
      );
    },

    // Advisory soft holds (via Acuity blocks)
    softHoldSlot: ({ providerId, datetime, duration, notes }) => {
      if (!providerId) {
        return Effect.fail(Errors.reservation('BLOCK_FAILED', 'Provider ID required for soft hold'));
      }

      const startTime = new Date(datetime);
      const endTime = new Date(startTime.getTime() + duration * 60 * 1000);

      return pipe(
        Effect.map(
          post<AcuityBlock>('/blocks', {
            calendarID: parseInt(providerId, 10),
            start: startTime.toISOString(),
            end: endTime.toISOString(),
            notes: notes ?? 'Payment pending - advisory soft hold',
          }),
          (block) => ({
            id: String(block.id),
            datetime,
            duration,
            expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
            providerId,
          } satisfies SlotSoftHold)
        ),
        Effect.mapError((e) =>
          Errors.reservation('BLOCK_FAILED', e._tag === 'AcuityError' ? e.message : 'Failed to create soft hold')
        )
      );
    },

    releaseSoftHold: (softHoldId) =>
      pipe(
        Effect.map(del<void>(`/blocks/${softHoldId}`), () => undefined),
        Effect.catch(() => Effect.succeed(undefined)) // Ignore errors when releasing
      ),

    // Bookings
    createBooking: (request) =>
      Effect.map(
        post<AcuityAppointment>('/appointments?admin=true', {
          appointmentTypeID: parseInt(request.serviceId, 10),
          calendarID: request.providerId ? parseInt(request.providerId, 10) : undefined,
          datetime: request.datetime,
          firstName: request.client.firstName,
          lastName: request.client.lastName,
          email: request.client.email,
          phone: request.client.phone,
          notes: request.client.notes,
        }),
        toBooking
      ),

    createBookingWithPaymentRef: (request, paymentRef, paymentProcessor) => {
      // Canonical wire format — Acuity can only persist strings (notes field).
      const paymentNote = formatPaymentRef({
        processor: paymentProcessor,
        transactionId: paymentRef,
      });
      const combinedNotes = request.client.notes
        ? `${request.client.notes}\n\n${paymentNote}`
        : paymentNote;

      return Effect.map(
        post<AcuityAppointment>('/appointments?admin=true', {
          appointmentTypeID: parseInt(request.serviceId, 10),
          calendarID: request.providerId ? parseInt(request.providerId, 10) : undefined,
          datetime: request.datetime,
          firstName: request.client.firstName,
          lastName: request.client.lastName,
          email: request.client.email,
          phone: request.client.phone,
          notes: combinedNotes,
        }),
        toBooking
      );
    },

    getBooking: (bookingId) =>
      Effect.map(get<AcuityAppointment>(`/appointments/${bookingId}`), toBooking),

    cancelBooking: (bookingId, reason) =>
      Effect.map(
        request<void>('PUT', `/appointments/${bookingId}/cancel`, { cancelNote: reason }),
        () => undefined
      ),

    rescheduleBooking: (bookingId, newDatetime) =>
      Effect.map(
        request<AcuityAppointment>('PUT', `/appointments/${bookingId}/reschedule`, { datetime: newDatetime }),
        toBooking
      ),

    // Clients
    findOrCreateClient: (client) =>
      Effect.map(
        get<{ id: number }[]>(`/clients?email=${encodeURIComponent(client.email)}`),
        (clients) => {
          if (clients.length > 0) {
            return { id: String(clients[0].id), isNew: false };
          }
          return { id: 'pending', isNew: true };
        }
      ),

    getClientByEmail: (email) =>
      Effect.map(
        get<AcuityAppointment[]>(`/clients?email=${encodeURIComponent(email)}`),
        (clients) => {
          if (clients.length === 0) return null;
          const c = clients[0];
          return {
            firstName: c.firstName,
            lastName: c.lastName,
            email: c.email,
            phone: c.phone,
          };
        }
      ),
  };
};

export type { AcuityAdapterConfig };
