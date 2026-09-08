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
const advanceToPaymentStep = async () => {
  // Service step
  const serviceCard = (await screen.findByText('Consultation')).closest('button');
  await fireEvent.click(serviceCard!);

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

  it.each(['callback failure', 'missing booking id', 'pending booking', 'missing capture id', 'confirmed'])('uses observed server receipts: %s', async (scenario) => {
    let approve: ((data: { orderID: string; payerID: string }) => Promise<void>) | undefined;
    vi.stubGlobal('paypal', {
      FUNDING: { VENMO: 'venmo' },
      Buttons: (config: { onApprove: NonNullable<typeof approve> }) => {
        approve = config.onApprove;
        return { render: vi.fn(async () => {}), close: vi.fn(), isEligible: () => true };
      },
    });
    const payment: PaymentResult = {
      success: true,
      transactionId: scenario === 'missing capture id' ? '' : 'CAPTURE-SYNTHETIC-1',
      processor: 'venmo',
      amount: service.price,
      currency: service.currency,
      timestamp: '2026-06-01T16:00:00.000Z',
    };
    const onBookWithPaymentRef = vi.fn(async () => {
      if (scenario === 'callback failure') throw new Error('synthetic timeout');
      return { booking: {
        id: scenario === 'missing booking id' ? undefined : 'BOOKING-SYNTHETIC-1',
        status: scenario === 'pending booking' ? 'pending' as const : 'confirmed' as const,
      } };
    });
    const { onBookingComplete } = renderDrawer({
      ...buildCapabilities([{ id: 'venmo', name: 'venmo', displayName: 'Venmo', available: true }]),
      venmo: { available: true, clientId: 'synthetic', environment: 'sandbox' },
    }, { onBookWithPaymentRef, onCapturePayment: vi.fn(async () => payment) });
    await advanceToPaymentStep();
    await selectPaymentOption('Venmo');
    await waitFor(() => expect(approve).toBeTypeOf('function'));
    await approve!({ orderID: 'ORDER-SYNTHETIC-1', payerID: 'PAYER-SYNTHETIC-1' });

    if (scenario === 'confirmed') {
      expect(await screen.findByText('Booking Confirmed!')).toBeInTheDocument();
      expect(onBookingComplete).toHaveBeenCalledWith(expect.objectContaining({ id: 'BOOKING-SYNTHETIC-1' }));
      return;
    }
    expect(await screen.findByText(/Do not pay again/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try Again' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Go back' })).not.toBeInTheDocument();
    expect(screen.queryByText('Booking Confirmed!')).not.toBeInTheDocument();
    expect(onBookingComplete).not.toHaveBeenCalled();
    if (scenario === 'missing capture id') {
      expect(onBookWithPaymentRef).not.toHaveBeenCalled();
      expect(screen.getByText(/Unavailable — provider verification required/)).toBeInTheDocument();
    } else {
      expect(screen.getByText(/CAPTURE-SYNTHETIC-1/)).toBeInTheDocument();
      expect(onBookWithPaymentRef).toHaveBeenCalledWith(expect.objectContaining({ paymentRef: 'CAPTURE-SYNTHETIC-1' }));
    }
  });
});
