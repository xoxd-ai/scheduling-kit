/**
 * HybridCheckoutDrawer Component Tests
 *
 * Render-level coverage of the real handlePaymentSelect routing (no
 * simulation): unavailable card/venmo selections and unknown method ids
 * must land on the error step and never fabricate a local booking via
 * manual completion. A missing durable booking command must fail before payment,
 * and a captured-but-unconfirmed payment must retain its reconciliation reference.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/svelte';
import type { ComponentProps } from 'svelte';
import HybridCheckoutDrawer from '../../src/components/HybridCheckoutDrawer.svelte';
import { getDefaultCapabilities } from '../../src/payments/types.js';
import type { PaymentCapabilities, PaymentMethodOption } from '../../src/payments/types.js';
import type { Service, PaymentResult } from '../../src/core/types.js';

const service: Service = {
  id: 'svc-1',
  name: 'Consultation',
  duration: 60,
  price: 15000,
  currency: 'USD',
  active: true,
};

const AVAILABLE_DATE = '2026-06-30';
// 2:00 PM America/New_York (drawer default timezone)
const SLOT_DATETIME = '2026-06-30T18:00:00.000Z';

const buildCapabilities = (methods: PaymentMethodOption[]): PaymentCapabilities => ({
  ...getDefaultCapabilities(),
  methods,
});

const renderDrawer = (
  capabilities: PaymentCapabilities,
  overrides: Partial<ComponentProps<typeof HybridCheckoutDrawer>> = {},
) => {
  const onBookingComplete = vi.fn();
  const onCreateStripeIntent = vi.fn();
  const onCreatePaymentOrder = vi.fn();
  const onCapturePayment = vi.fn();

  render(HybridCheckoutDrawer, {
    props: {
      open: true,
      services: [service],
      skipProvider: true,
      capabilities,
      onLoadDates: vi.fn(async () => [AVAILABLE_DATE]),
      onLoadSlots: vi.fn(async () => [{ datetime: SLOT_DATETIME, available: true }]),
      onCreateStripeIntent,
      onCreatePaymentOrder,
      onCapturePayment,
      onBookingComplete,
      ...overrides,
    },
  });

  return { onBookingComplete, onCreateStripeIntent, onCreatePaymentOrder, onCapturePayment };
};

/** Walk the real drawer from service selection to the payment step. */
const advanceToPaymentStep = async (providerName?: string) => {
  // Service step
  const serviceCard = (await screen.findByText('Consultation')).closest('button');
  await fireEvent.click(serviceCard!);
  if (providerName) {
    await fireEvent.click((await screen.findByText(providerName)).closest('button')!);
  }

  // Datetime step (skipProvider: true jumps straight here)
  const dayButton = await screen.findByRole('button', { name: /June 30, available/ });
  await fireEvent.click(dayButton);
  const slotButton = await screen.findByRole('button', { name: '2:00 PM' });
  await fireEvent.click(slotButton);

  // Details step (showIntakeFields is hardcoded true in the drawer)
  await screen.findByLabelText(/first name/i);
  await fireEvent.input(screen.getByLabelText(/first name/i), { target: { value: 'Pat' } });
  await fireEvent.input(screen.getByLabelText(/last name/i), { target: { value: 'Tester' } });
  await fireEvent.input(screen.getByLabelText(/email/i), { target: { value: 'pat@example.com' } });

  for (const radio of Array.from(
    document.querySelectorAll<HTMLInputElement>('input[type="radio"][value="no"]')
  )) {
    await fireEvent.click(radio);
  }
  const checkboxes = Array.from(
    document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
  );
  // First "how did you hear" option + the terms acknowledgement (last checkbox)
  await fireEvent.click(checkboxes[0]);
  await fireEvent.click(checkboxes[checkboxes.length - 1]);
  await fireEvent.input(screen.getByLabelText(/current medications/i), {
    target: { value: 'None' },
  });

  await fireEvent.submit(document.querySelector('form.client-form, form')!);

  // Payment step
  await screen.findByText('Select Payment Method');
};

const selectPaymentOption = async (displayName: string) => {
  const optionButton = screen.getByText(displayName).closest('button');
  await fireEvent.click(optionButton!);
};

describe('HybridCheckoutDrawer payment routing', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 5, 1, 12, 0, 0, 0));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('errors card selections when Stripe is unavailable and never completes a booking', async () => {
    const { onBookingComplete, onCreateStripeIntent } = renderDrawer(
      buildCapabilities([
        { id: 'card', name: 'card', displayName: 'Credit/Debit Card', available: true },
      ])
    );

    await advanceToPaymentStep();
    await selectPaymentOption('Credit/Debit Card');

    expect(
      await screen.findByText('Card payments are not available right now.')
    ).toBeInTheDocument();
    // Step title + error heading both show the error step
    expect(screen.getAllByText('Something Went Wrong').length).toBeGreaterThan(0);
    expect(onCreateStripeIntent).not.toHaveBeenCalled();
    expect(onBookingComplete).not.toHaveBeenCalled();
  });

  it('errors venmo selections when Venmo is unavailable instead of manual completion', async () => {
    const { onBookingComplete } = renderDrawer(
      buildCapabilities([{ id: 'venmo', name: 'venmo', displayName: 'Venmo', available: true }])
    );

    await advanceToPaymentStep();
    await selectPaymentOption('Venmo');

    expect(
      await screen.findByText('Venmo payments are not available right now.')
    ).toBeInTheDocument();
    expect(screen.getAllByText('Something Went Wrong').length).toBeGreaterThan(0);
    expect(onBookingComplete).not.toHaveBeenCalled();
  });

  it('errors unknown method ids instead of manual completion', async () => {
    const { onBookingComplete } = renderDrawer(
      buildCapabilities([
        { id: 'bitcoin', name: 'bitcoin', displayName: 'Bitcoin', available: true },
      ])
    );

    await advanceToPaymentStep();
    await selectPaymentOption('Bitcoin');

    expect(
      await screen.findByText(
        'This payment method is not supported in the current checkout flow.'
      )
    ).toBeInTheDocument();
    expect(screen.getAllByText('Something Went Wrong').length).toBeGreaterThan(0);
    expect(onBookingComplete).not.toHaveBeenCalled();
  });

  it.each(['cash', 'venmo-direct'])('does not invent a paid manual booking for %s', async (method) => {
    const { onBookingComplete } = renderDrawer(
      buildCapabilities([{ id: method, name: method, displayName: 'Manual payment', available: true }])
    );

    await advanceToPaymentStep();
    await selectPaymentOption('Manual payment');

    expect(await screen.findByText(/cannot persist manual-payment bookings/)).toBeInTheDocument();
    expect(screen.queryByText('Booking Confirmed!')).not.toBeInTheDocument();
    expect(onBookingComplete).not.toHaveBeenCalled();
  });

  it.each(['card', 'venmo'])('refuses %s before starting payment without a server booking command', async (method) => {
    const capabilities = {
      ...buildCapabilities([{ id: method, name: method, displayName: 'Automated payment', available: true }]),
      stripe: { available: true, publishableKey: 'pk_test_synthetic' },
      venmo: { available: true, clientId: 'synthetic', environment: 'sandbox' as const },
    };
    const callbacks = renderDrawer(capabilities);
    await advanceToPaymentStep();
    await selectPaymentOption('Automated payment');

    expect(await screen.findByText('Booking is unavailable. No payment has been started.')).toBeInTheDocument();
    expect(callbacks.onCreateStripeIntent).not.toHaveBeenCalled();
    expect(callbacks.onCreatePaymentOrder).not.toHaveBeenCalled();
    expect(callbacks.onCapturePayment).not.toHaveBeenCalled();
    expect(callbacks.onBookingComplete).not.toHaveBeenCalled();
  });

  it.each([true, false])('can leave an idle Venmo checkout (eligible=%s) without creating an order', async (eligible) => {
    const renderButton = vi.fn(async () => {});
    vi.stubGlobal('paypal', {
      FUNDING: { VENMO: 'venmo' },
      Buttons: () => ({ render: renderButton, close: vi.fn(), isEligible: () => eligible }),
    });
    const callbacks = renderDrawer({
      ...buildCapabilities([{ id: 'venmo', name: 'venmo', displayName: 'Venmo', available: true }]),
      venmo: { available: true, clientId: 'synthetic', environment: 'sandbox' },
    }, { onBookWithPaymentRef: vi.fn() });
    await advanceToPaymentStep();
    await selectPaymentOption('Venmo');
    if (eligible) await waitFor(() => expect(renderButton).toHaveBeenCalled());
    else expect(await screen.findByText('Venmo is not available in your browser or region.')).toBeInTheDocument();
    await fireEvent.click(await screen.findByRole('button', { name: 'Choose a different payment method' }));
    expect(await screen.findByText('Select Payment Method')).toBeInTheDocument();
    expect(callbacks.onCreatePaymentOrder).not.toHaveBeenCalled();
    expect(callbacks.onCapturePayment).not.toHaveBeenCalled();
  });

  it.each([
    'callback failure', 'missing booking id', 'pending booking', 'missing capture id',
    'wrong amount', 'wrong currency', 'wrong processor', 'wrong service', 'wrong time',
    'same receipt', 'second capture', 'conflicting capture', 'confirmed', 'incumbent zero-dollar',
    'native reference', 'encoded reference', 'other native capture', 'other encoded capture',
    'native processor conflict', 'wrong provider', 'matching provider',
  ])('uses observed server receipts: %s', async (scenario) => {
    let approve: ((data: { orderID: string; payerID: string }) => Promise<void>) | undefined;
    let createOrder: (() => Promise<string>) | undefined;
    vi.stubGlobal('paypal', {
      FUNDING: { VENMO: 'venmo' },
      Buttons: (config: { onApprove: NonNullable<typeof approve>; createOrder: NonNullable<typeof createOrder> }) => {
        approve = config.onApprove;
        createOrder = config.createOrder;
        return { render: vi.fn(async () => {}), close: vi.fn(), isEligible: () => true };
      },
    });
    const payment: PaymentResult = {
      success: true,
      transactionId: scenario === 'missing capture id' ? '' : 'CAPTURE-SYNTHETIC-1',
      processor: scenario === 'wrong processor' ? 'stripe' : 'venmo',
      amount: scenario === 'wrong amount' ? service.price - 1 : service.price,
      currency: scenario === 'wrong currency' ? 'CAD' : service.currency,
      timestamp: '2026-06-01T16:00:00.000Z',
    };
    const replaysCapture = ['same receipt', 'second capture', 'conflicting capture'].includes(scenario);
    const selectsProvider = ['wrong provider', 'matching provider'].includes(scenario);
    let releaseBooking: (() => void) | undefined;
    const bookingGate = replaysCapture ? new Promise<void>((resolve) => { releaseBooking = resolve; }) : Promise.resolve();
    const onBookWithPaymentRef = vi.fn(async () => {
      await bookingGate;
      if (scenario === 'callback failure') throw new Error('synthetic timeout');
      return { booking: {
        id: scenario === 'missing booking id' ? undefined : 'BOOKING-SYNTHETIC-1',
        status: scenario === 'pending booking' ? 'pending' as const : 'confirmed' as const,
        serviceId: scenario === 'wrong service' ? 'OTHER-SERVICE' : service.id,
        serviceName: service.name,
        datetime: scenario === 'wrong time' ? '2026-07-01T18:00:00.000Z' : SLOT_DATETIME,
        price: scenario === 'incumbent zero-dollar' ? 0 : service.price,
        providerId: scenario === 'wrong provider' ? 'OTHER-PROVIDER' : 'PROVIDER-SYNTHETIC-1',
        paymentMethod: scenario === 'native processor conflict' ? 'stripe' : undefined,
        paymentRef: ({
          'native reference': 'CAPTURE-SYNTHETIC-1',
          'encoded reference': 'Synthetic notes [VENMO] Transaction: CAPTURE-SYNTHETIC-1',
          'other native capture': 'CAPTURE-OTHER',
          'other encoded capture': '[VENMO] Transaction: CAPTURE-OTHER',
        } as Record<string, string>)[scenario],
      } };
    });
    const secondPayment = {
      ...payment,
      transactionId: scenario === 'second capture' ? 'CAPTURE-SYNTHETIC-2' : payment.transactionId,
      amount: scenario === 'conflicting capture' ? payment.amount + 1 : payment.amount,
    };
    const onCapturePayment = vi.fn().mockResolvedValueOnce(payment).mockResolvedValue(secondPayment);
    const { onBookingComplete } = renderDrawer({
      ...buildCapabilities([{ id: 'venmo', name: 'venmo', displayName: 'Venmo', available: true }]),
      venmo: { available: true, clientId: 'synthetic', environment: 'sandbox' },
    }, {
      onBookWithPaymentRef,
      onCapturePayment,
      onCreatePaymentOrder: vi.fn(async () => ({
        id: 'ORDER-SYNTHETIC-1', amount: service.price, currency: service.currency,
        status: 'pending' as const, processor: 'venmo', createdAt: payment.timestamp,
      })),
      skipProvider: !selectsProvider,
      providers: [{ id: 'PROVIDER-SYNTHETIC-1', name: 'Synthetic Provider', timezone: 'America/New_York' }],
    });
    await advanceToPaymentStep(selectsProvider ? 'Synthetic Provider' : undefined);
    await selectPaymentOption('Venmo');
    await waitFor(() => expect(approve).toBeTypeOf('function'));
    // The child permits idle cancellation, then locks switching while its
    // created order awaits approval/capture. Parent close stays guarded.
    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choose a different payment method' })).toBeInTheDocument();
    await createOrder!();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Choose a different payment method' })).not.toBeInTheDocument());
    await approve!({ orderID: 'ORDER-SYNTHETIC-1', payerID: 'PAYER-SYNTHETIC-1' });
    if (replaysCapture) {
      await waitFor(() => expect(onBookWithPaymentRef).toHaveBeenCalledTimes(1));
      await approve!({ orderID: 'ORDER-SYNTHETIC-2', payerID: 'PAYER-SYNTHETIC-1' });
      releaseBooking!();
    }

    if (['confirmed', 'same receipt', 'incumbent zero-dollar', 'native reference', 'encoded reference', 'matching provider'].includes(scenario)) {
      expect(await screen.findByText('Booking Confirmed!')).toBeInTheDocument();
      expect(onBookingComplete).toHaveBeenCalledWith(expect.objectContaining({ id: 'BOOKING-SYNTHETIC-1' }));
      expect(onBookWithPaymentRef).toHaveBeenCalledTimes(1);
      return;
    }
    expect(await screen.findByText(/Do not pay again/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try Again' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Go back' })).not.toBeInTheDocument();
    expect(screen.queryByText('Booking Confirmed!')).not.toBeInTheDocument();
    expect(onBookingComplete).not.toHaveBeenCalled();
    if (['missing capture id', 'wrong amount', 'wrong currency', 'wrong processor'].includes(scenario)) {
      expect(onBookWithPaymentRef).not.toHaveBeenCalled();
      if (scenario === 'missing capture id') {
        expect(screen.getByText(/Unavailable — provider verification required/)).toBeInTheDocument();
      }
    } else {
      expect(screen.getAllByText(/CAPTURE-SYNTHETIC-1/).length).toBeGreaterThan(0);
      expect(onBookWithPaymentRef).toHaveBeenCalledWith(expect.objectContaining({ paymentRef: 'CAPTURE-SYNTHETIC-1' }));
      expect(onBookWithPaymentRef).toHaveBeenCalledTimes(1);
      if (scenario === 'second capture') {
        expect(screen.getByText(/CAPTURE-SYNTHETIC-2/)).toBeInTheDocument();
      }
      if (scenario === 'conflicting capture') {
        expect(screen.getAllByText(/CAPTURE-SYNTHETIC-1/)).toHaveLength(2);
      }
    }
  });
});
