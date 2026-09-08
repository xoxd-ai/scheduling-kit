<script lang="ts">
  /**
   * HybridCheckoutDrawer Component
   * Unified out-of-band payment checkout flow
   *
   * Flow:
   * 1. Custom UI for service/provider/datetime/client selection
   * 2. Payment method selection (Venmo, Card via Stripe)
   * 3. Collect payment via our own adapter
   * 4. Hand booking off to adopter-provided completion logic
   */
  import type { Service, Provider, ClientInfo, TimeSlot, Booking, PaymentIntent, PaymentResult } from '../core/types.js';
  import type { AcuityBookingData } from '../lib/acuity-listener.js';
  import type { OrderCreateParams } from './VenmoCheckout.svelte';
  import { Dialog, Portal } from '@skeletonlabs/skeleton-svelte';
  import ServicePicker from './ServicePicker.svelte';
  import ProviderPicker from './ProviderPicker.svelte';
  import DateTimePicker from './DateTimePicker.svelte';
  import ClientForm from './ClientForm.svelte';
  import BookingConfirmation from './BookingConfirmation.svelte';
  import VenmoCheckout from './VenmoCheckout.svelte';
  import StripeCheckout from './StripeCheckout.svelte';
  import type { PaymentCapabilities } from '../payments/types.js';
  import {
    getDefaultCapabilities,
    isCardPaymentMethodId,
    isManualPaymentMethodId,
    toPublicPaymentMethodId,
  } from '../payments/types.js';

  // =============================================================================
  // TYPES
  // =============================================================================

  type HybridStep =
    | 'service'
    | 'provider'
    | 'datetime'
    | 'details'
    | 'payment'
    | 'venmo-checkout'
    | 'stripe-checkout'
    | 'processing'
    | 'complete'
    | 'error';

  // =============================================================================
  // PROPS
  // =============================================================================

  let {
    open = $bindable(false),
    services = [],
    providers = [],
    loadingServices = false,
    loadingProviders = false,
    capabilities = getDefaultCapabilities(),
    onClose,
    onLoadDates,
    onLoadSlots,
    onCreatePaymentOrder,
    onCapturePayment,
    onCreateStripeIntent,
    onBookWithPaymentRef,
    onBookingComplete,
    timezone = 'America/New_York',
    skipProvider = false,
    debug = false,
  }: {
    /** Whether drawer is open */
    open?: boolean;
    /** Available services from the adopter's scheduling source */
    services?: Service[];
    /** Available providers */
    providers?: Provider[];
    /** Loading state for services */
    loadingServices?: boolean;
    /** Loading state for providers */
    loadingProviders?: boolean;
    /** Server-derived payment capabilities */
    capabilities?: PaymentCapabilities;
    /** Close callback */
    onClose?: () => void;
    /** Load available dates callback (startDate/endDate override default 60-day window) */
    onLoadDates?: (serviceId: string, providerId?: string, startDate?: string, endDate?: string) => Promise<string[]>;
    /** Load time slots callback */
    onLoadSlots?: (serviceId: string, date: string, providerId?: string) => Promise<TimeSlot[]>;
    /** Create a PayPal order for Venmo approval */
    onCreatePaymentOrder?: (params: OrderCreateParams) => Promise<PaymentIntent>;
    /** Capture an approved PayPal order */
    onCapturePayment?: (intentId: string) => Promise<PaymentResult>;
    /** Create a Stripe PaymentIntent (returns clientSecret + intentId) */
    onCreateStripeIntent?: (params: { amount: number; currency: string; description: string }) => Promise<{ clientSecret: string; intentId: string }>;
    /** Required for automated checkout: return the persisted, confirmed server booking receipt. */
    onBookWithPaymentRef?: (params: { serviceId: string; datetime: string; client: ClientInfo; paymentRef: string; paymentProcessor: string }) => Promise<{ booking: Partial<Booking> }>;
    /** Booking complete callback */
    onBookingComplete?: (booking: Partial<Booking> | AcuityBookingData) => void;
    /** IANA timezone for date/time display */
    timezone?: string;
    /** Skip provider step (single-provider businesses) */
    skipProvider?: boolean;
    /** Enable debug logging */
    debug?: boolean;
  } = $props();

  // =============================================================================
  // STATE
  // =============================================================================

  let step = $state<HybridStep>('service');
  let selectedService = $state<Service | undefined>(undefined);
  let selectedProvider = $state<Provider | undefined>(undefined);
  let selectedDatetime = $state<string | undefined>(undefined);
  let selectedDate = $state<string | undefined>(undefined);
  let clientInfo = $state<ClientInfo | undefined>(undefined);
  let selectedPayment = $state<string | undefined>(undefined);
  let errorMessage = $state<string | undefined>(undefined);
  let completedBooking = $state<Partial<Booking> | AcuityBookingData | undefined>(undefined);
  // Retain the original capture observation if booking cannot be confirmed.
  // This is a UI pointer for reconciliation, not a second durable payment store.
  let paymentReceipt = $state<PaymentResult | undefined>(undefined);

  // Data loading
  let availableDates = $state<string[]>([]);
  let availableSlots = $state<TimeSlot[]>([]);
  let loadingDates = $state(false);
  let loadingSlots = $state(false);
  let processing = $state(false);

  // Stripe intent (created server-side when user selects card payment)
  let stripeIntent = $state<{ clientSecret: string; intentId: string } | undefined>(undefined);

  // Payment options — derived from server-provided capabilities
  const paymentOptions = $derived(capabilities.methods);

  // =============================================================================
  // DERIVED
  // =============================================================================

  const stepTitles: Record<HybridStep, string> = {
    service: 'Select a Service',
    provider: 'Choose Your Provider',
    datetime: 'Pick a Date & Time',
    details: 'Your Information',
    payment: 'Payment Method',
    'venmo-checkout': 'Pay with Venmo',
    'stripe-checkout': 'Pay with Card',
    processing: 'Processing...',
    complete: 'Booking Confirmed',
    error: 'Something Went Wrong',
  };

  const progress = $derived.by(() => {
    const steps: HybridStep[] = skipProvider
      ? ['service', 'datetime', 'details', 'payment']
      : ['service', 'provider', 'datetime', 'details', 'payment'];
    const index = steps.indexOf(step);
    if (index === -1) return 100;
    return Math.round(((index + 1) / steps.length) * 100);
  });

  const canGoBack = $derived(
    !paymentReceipt && step !== 'service' && step !== 'complete' && step !== 'processing' && step !== 'venmo-checkout' && step !== 'stripe-checkout'
  );

  // =============================================================================
  // HANDLERS
  // =============================================================================

  const handleServiceSelect = (service: Service) => {
    selectedService = service;
    if (skipProvider) {
      step = 'datetime';
      loadDatesForService();
    } else {
      step = 'provider';
    }
  };

  const handleProviderSelect = (provider: Provider | undefined) => {
    selectedProvider = provider;
    step = 'datetime';
    loadDatesForService();
  };

  const loadDatesForService = async (startDate?: string, endDate?: string) => {
    if (!selectedService || !onLoadDates) return;
    loadingDates = true;
    try {
      const dates = await onLoadDates(selectedService.id, selectedProvider?.id, startDate, endDate);
      if (startDate) {
        // Merge with existing dates (month navigation), deduplicate
        const merged = new Set([...availableDates, ...dates]);
        availableDates = [...merged].sort();
      } else {
        availableDates = dates;
      }
    } catch (e) {
      console.error('Failed to load dates:', e);
      if (!startDate) availableDates = [];
    }
    loadingDates = false;
  };

  const handleMonthChange = (startDate: string, endDate: string) => {
    // Check if we already have dates in this range
    const hasDataForMonth = availableDates.some(d => d >= startDate && d <= endDate);
    if (!hasDataForMonth) {
      loadDatesForService(startDate, endDate);
    }
  };

  const handleDateSelect = async (date: string) => {
    if (!selectedService || !onLoadSlots) return;
    selectedDate = date;
    loadingSlots = true;
    try {
      availableSlots = await onLoadSlots(selectedService.id, date, selectedProvider?.id);
    } catch (e) {
      console.error('Failed to load slots:', e);
      availableSlots = [];
    }
    loadingSlots = false;
  };

  const handleTimeSelect = (datetime: string) => {
    selectedDatetime = datetime;
    step = 'details';
  };

  const handleClientSubmit = (client: ClientInfo) => {
    clientInfo = client;
    step = 'payment';
  };

  const handlePaymentSelect = async (paymentId: string) => {
    if (paymentReceipt || processing) return;
    // Selector state always holds the canonical public id ('card', never the
    // internal 'stripe' adapter name).
    selectedPayment = toPublicPaymentMethodId(paymentId);

    if (paymentId === 'venmo' && capabilities.venmo?.available && onCreatePaymentOrder && onCapturePayment) {
      if (!onBookWithPaymentRef) {
        errorMessage = 'Booking is unavailable. No payment has been started.';
        step = 'error';
        return;
      }
      // Use PayPal SDK flow for Venmo — requires client-side approval
      step = 'venmo-checkout';
    } else if (paymentId === 'venmo') {
      // Venmo selected but not available — never fall through to manual completion
      errorMessage = 'Venmo payments are not available right now.';
      step = 'error';
    } else if (isCardPaymentMethodId(paymentId) && capabilities.stripe?.available && onCreateStripeIntent && selectedService) {
      if (!onBookWithPaymentRef) {
        errorMessage = 'Booking is unavailable. No payment has been started.';
        step = 'error';
        return;
      }
      // Public 'card' (and the legacy 'stripe' alias) -> Stripe Elements flow.
      // Create PaymentIntent server-side, then show Stripe Elements
      step = 'processing';
      try {
        stripeIntent = await onCreateStripeIntent({
          amount: selectedService.price,
          currency: selectedService.currency ?? 'USD',
          description: selectedService.name,
        });
        step = 'stripe-checkout';
      } catch (e) {
        errorMessage = e instanceof Error ? e.message : 'Failed to initialize payment';
        step = 'error';
      }
    } else if (isCardPaymentMethodId(paymentId)) {
      // Card selected but Stripe is unavailable — never fall through to manual completion
      errorMessage = 'Card payments are not available right now.';
      step = 'error';
    } else if (isManualPaymentMethodId(paymentId)) {
      // The standalone manual/direct-Venmo adapters remain supported. This
      // drawer has no server command for an unpaid booking, so cannot fake one.
      errorMessage = 'This checkout cannot persist manual-payment bookings yet. Contact the business to book. No payment has been collected.';
      step = 'error';
    } else {
      errorMessage = 'This payment method is not supported in the current checkout flow.';
      step = 'error';
    }
  };

  const handleCapturedPayment = async (result: PaymentResult, processor: 'venmo' | 'stripe') => {
    // Deduplicate SDK callbacks and retain the original receipt even if the
    // consumer callback disappears or the selected form state is unavailable.
    if (paymentReceipt) return;
    paymentReceipt = result;
    step = 'processing';
    processing = true;

    try {
      if (!result.success || !result.transactionId?.trim() || result.metadata?.status === 'pending_collection') {
        throw new Error('Payment capture needs verification.');
      }
      if (!selectedService || !clientInfo || !selectedDatetime || !onBookWithPaymentRef) {
        throw new Error('The booking command is unavailable.');
      }
      const { booking } = await onBookWithPaymentRef({
        serviceId: selectedService.id,
        datetime: selectedDatetime,
        client: clientInfo,
        paymentRef: result.transactionId,
        paymentProcessor: processor,
      });
      completedBooking = booking;
      if (!booking.id?.trim() || booking.status !== 'confirmed') {
        throw new Error('The server did not return a confirmed booking receipt.');
      }
      step = 'complete';
    } catch {
      // Do not offer a payment retry or discard the observation: capture and
      // booking are separate effects, and a timeout can have committed either.
      errorMessage = 'Your booking is not confirmed. Do not pay again. Contact the business with the payment reference below so they can verify the payment and booking.';
      step = 'error';
    } finally {
      processing = false;
    }
    // A consumer notification error cannot undo a confirmed server receipt.
    if (step === 'complete' && completedBooking) onBookingComplete?.(completedBooking);
  };

  const handleVenmoSuccess = (result: PaymentResult) => handleCapturedPayment(result, 'venmo');
  const handleStripeSuccess = (result: PaymentResult) => handleCapturedPayment(result, 'stripe');

  const handleVenmoCancel = () => {
    if (paymentReceipt) return;
    step = 'payment';
  };

  const handleStripeCancel = () => {
    if (paymentReceipt) return;
    stripeIntent = undefined;
    step = 'payment';
  };

  const handleBack = () => {
    if (paymentReceipt) return;
    errorMessage = undefined;
    switch (step) {
      case 'provider':
        step = 'service';
        break;
      case 'datetime':
        step = skipProvider ? 'service' : 'provider';
        break;
      case 'details':
        step = 'datetime';
        break;
      case 'payment':
        step = 'details';
        break;
      case 'venmo-checkout':
        step = 'payment';
        break;
      case 'stripe-checkout':
        stripeIntent = undefined;
        step = 'payment';
        break;
      case 'error':
        step = 'payment';
        break;
    }
  };

  const handleClose = () => {
    open = false;
    onClose?.();
  };

  const handleNewBooking = () => {
    if (paymentReceipt && step !== 'complete') return;
    // Reset state
    step = 'service';
    selectedService = undefined;
    selectedProvider = undefined;
    selectedDatetime = undefined;
    selectedDate = undefined;
    clientInfo = undefined;
    selectedPayment = undefined;
    errorMessage = undefined;
    completedBooking = undefined;
    paymentReceipt = undefined;
    stripeIntent = undefined;
    availableDates = [];
    availableSlots = [];
  };

  // Format price
  const formatPrice = (cents: number): string =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
</script>

<Dialog
  open={open}
  onOpenChange={(details: { open: boolean }) => {
    if (!details.open) handleClose();
  }}
  closeOnInteractOutside={true}
>
  <Portal>
    <Dialog.Backdrop class="fixed inset-0 z-50 bg-black/50 modal-backdrop" />
    <Dialog.Positioner class="fixed inset-0 z-50 flex justify-center items-end md:items-center md:p-4">
      <Dialog.Content class="modal-panel bg-surface-50-950 shadow-2xl w-full overflow-hidden flex flex-col rounded-t-xl md:rounded-xl max-h-[90vh] md:max-h-[85vh] md:max-w-lg">
        <!-- Header -->
        <header class="drawer-header flex items-center justify-between p-4 border-b border-surface-200-800">
          <div class="flex items-center gap-3">
            {#if canGoBack}
              <button type="button" class="btn btn-sm preset-tonal" onclick={handleBack} aria-label="Go back">
                ←
              </button>
            {/if}
            <Dialog.Title class="text-lg font-semibold">{stepTitles[step]}</Dialog.Title>
          </div>
          <Dialog.CloseTrigger class="btn btn-sm preset-tonal" aria-label="Close">
            ✕
          </Dialog.CloseTrigger>
        </header>

        <!-- Progress Bar -->
        {#if step !== 'complete' && step !== 'error' && step !== 'venmo-checkout' && step !== 'stripe-checkout'}
          <div class="progress-bar h-1 bg-surface-200-800">
            <div class="h-full bg-primary-500 transition-all duration-300" style="width: {progress}%"></div>
          </div>
        {/if}

        <!-- Content -->
        <main class="drawer-content flex-1 overflow-y-auto p-6">
          <!-- Error Banner -->
          {#if errorMessage && step !== 'error'}
            <div class="error-banner bg-error-100-900 text-error-700-300 p-4 rounded-container mb-6">
              <p>{errorMessage}</p>
            </div>
          {/if}

      <!-- Step Content -->
      {#if step === 'service'}
        <ServicePicker
          {services}
          selectedService={selectedService}
          loading={loadingServices}
          onSelect={handleServiceSelect}
        />

      {:else if step === 'provider'}
        <ProviderPicker
          {providers}
          selectedProvider={selectedProvider}
          loading={loadingProviders}
          allowAny={true}
          onSelect={handleProviderSelect}
        />

      {:else if step === 'datetime'}
        <DateTimePicker
          availableDates={availableDates.map((d) => ({ date: d, slots: 1 }))}
          availableSlots={availableSlots}
          bind:selectedDate={selectedDate}
          bind:selectedTime={selectedDatetime}
          loading={loadingDates}
          loadingSlots={loadingSlots}
          timezone={timezone}
          onDateSelect={handleDateSelect}
          onTimeSelect={handleTimeSelect}
          onMonthChange={handleMonthChange}
        />

      {:else if step === 'details'}
        <ClientForm
          initialData={clientInfo}
          loading={processing}
          showIntakeFields={true}
          onSubmit={handleClientSubmit}
        />

      {:else if step === 'payment'}
        <div class="payment-step">
          <!-- Summary -->
          {#if selectedService}
            <div class="booking-summary bg-surface-100-900 rounded-container p-4 mb-6">
              <div class="flex justify-between items-center">
                <div>
                  <p class="font-medium">{selectedService.name}</p>
                  <p class="text-sm text-surface-600-400">{selectedService.duration} min</p>
                </div>
                <p class="text-xl font-bold text-primary-600-400">
                  {formatPrice(selectedService.price)}
                </p>
              </div>
            </div>
          {/if}

          <h4 class="text-md font-medium mb-4">Select Payment Method</h4>

          <div class="payment-options space-y-3">
            {#each paymentOptions as option (option.id)}
              <button
                type="button"
                class="payment-option w-full p-4 rounded-container text-left flex items-center gap-4
                       bg-surface-100-900 hover:bg-surface-200-800 transition-colors"
                onclick={() => handlePaymentSelect(option.id)}
              >
                <span class="text-2xl">{option.icon ?? ''}</span>
                <div class="flex-1">
                  <p class="font-medium">{option.displayName}</p>
                  <p class="text-sm text-surface-600-400">{option.description ?? ''}</p>
                </div>
                <span class="text-surface-400-600">→</span>
              </button>
            {/each}
          </div>
        </div>

      {:else if step === 'venmo-checkout'}
        <div class="venmo-step">
          {#if selectedService}
            <div class="booking-summary bg-surface-100-900 rounded-container p-4 mb-6">
              <div class="flex justify-between items-center">
                <div>
                  <p class="font-medium">{selectedService.name}</p>
                  <p class="text-sm text-surface-600-400">{selectedService.duration} min</p>
                </div>
                <p class="text-xl font-bold text-primary-600-400">
                  {formatPrice(selectedService.price)}
                </p>
              </div>
            </div>
          {/if}

          {#if capabilities.venmo?.available && onCreatePaymentOrder && onCapturePayment && selectedService}
            <VenmoCheckout
              clientId={capabilities.venmo?.clientId ?? ''}
              environment={capabilities.venmo?.environment ?? 'sandbox'}
              amount={selectedService.price}
              currency={selectedService.currency ?? 'USD'}
              description={selectedService.name}
              onCreateOrder={onCreatePaymentOrder}
              onCapturePayment={onCapturePayment}
              onSuccess={handleVenmoSuccess}
              onError={(e) => { errorMessage = e.message; step = 'error'; }}
              onCancel={handleVenmoCancel}
              {debug}
            />
          {/if}

          <button
            type="button"
            class="btn btn-sm preset-tonal mt-4 w-full"
            onclick={handleVenmoCancel}
          >
            Choose a different payment method
          </button>
        </div>

      {:else if step === 'stripe-checkout'}
        <div class="stripe-step">
          {#if selectedService}
            <div class="booking-summary bg-surface-100-900 rounded-container p-4 mb-6">
              <div class="flex justify-between items-center">
                <div>
                  <p class="font-medium">{selectedService.name}</p>
                  <p class="text-sm text-surface-600-400">{selectedService.duration} min</p>
                </div>
                <p class="text-xl font-bold text-primary-600-400">
                  {formatPrice(selectedService.price)}
                </p>
              </div>
            </div>
          {/if}

          {#if capabilities.stripe?.available && stripeIntent && selectedService}
            <StripeCheckout
              publishableKey={capabilities.stripe?.publishableKey ?? ''}
              clientSecret={stripeIntent.clientSecret}
              amount={selectedService.price}
              currency={selectedService.currency ?? 'USD'}
              onSuccess={handleStripeSuccess}
              onCancel={handleStripeCancel}
              onError={(e) => { errorMessage = e.message; step = 'error'; }}
            />
          {/if}
        </div>

      {:else if step === 'processing'}
        <div class="processing-step text-center py-12">
          <span class="spinner-large"></span>
          <p class="mt-4 text-surface-600-400">Processing your booking...</p>
        </div>

      {:else if step === 'complete'}
        <div class="complete-step">
          <div class="success-icon w-16 h-16 rounded-full bg-success-100-900 flex items-center justify-center mx-auto mb-4">
            <span class="text-3xl">✓</span>
          </div>
          <h3 class="text-xl font-semibold text-center mb-2">Booking Confirmed!</h3>

          {#if completedBooking}
            <div class="booking-details bg-surface-100-900 rounded-container p-4 mt-6">
              {#if 'appointmentType' in completedBooking}
                <!-- AcuityBookingData -->
                <p><strong>Service:</strong> {completedBooking.appointmentType}</p>
                <p><strong>Date:</strong> {completedBooking.date} at {completedBooking.time}</p>
                <p><strong>Confirmation #:</strong> {completedBooking.appointmentId}</p>
              {:else}
                <!-- Local Booking -->
                <p><strong>Service:</strong> {selectedService?.name}</p>
                <p><strong>Date:</strong> {selectedDatetime ? new Date(selectedDatetime).toLocaleString() : ''}</p>
                <p><strong>Payment:</strong> {selectedPayment}</p>
              {/if}
            </div>
          {/if}

          <div class="actions mt-6 space-y-3">
            <button
              type="button"
              class="btn w-full preset-filled-primary-500"
              onclick={handleClose}
            >
              Done
            </button>
            <button
              type="button"
              class="btn w-full preset-tonal"
              onclick={handleNewBooking}
            >
              Book Another Appointment
            </button>
          </div>
        </div>

      {:else if step === 'error'}
        <div class="error-step text-center py-8">
          <div class="w-16 h-16 rounded-full bg-error-100-900 flex items-center justify-center mx-auto mb-4">
            <span class="text-2xl">✕</span>
          </div>
          <h3 class="text-lg font-semibold mb-2">Something Went Wrong</h3>
          <p class="text-surface-600-400 mb-6">{errorMessage || 'An error occurred.'}</p>
          {#if paymentReceipt}
            <div class="payment-reconciliation text-left rounded-container bg-surface-100-900 p-4" role="status">
              <p><strong>Payment processor:</strong> {paymentReceipt.processor}</p>
              <p><strong>Payment reference:</strong> {paymentReceipt.transactionId || 'Unavailable — provider verification required'}</p>
              <p><strong>Payment observation:</strong> {paymentReceipt.timestamp}</p>
              {#if completedBooking && 'id' in completedBooking && completedBooking.id}
                <p><strong>Booking reference to verify:</strong> {completedBooking.id}</p>
              {/if}
              <p>Save this reference before leaving. Do not submit a second payment.</p>
            </div>
          {:else}
            <button type="button" class="btn preset-filled-primary-500" onclick={handleBack}>
              Try Again
            </button>
          {/if}
        </div>
      {/if}
    </main>
      </Dialog.Content>
    </Dialog.Positioner>
  </Portal>
</Dialog>

<style>
  :global(.modal-panel) {
    animation: modalIn 0.25s ease-out;
  }

  @keyframes modalIn {
    from { opacity: 0; transform: scale(0.95) translateY(10px); }
    to { opacity: 1; transform: scale(1) translateY(0); }
  }

  :global(.modal-backdrop) {
    animation: fadeIn 0.2s ease-out;
  }

  @keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  .spinner-large {
    display: inline-block;
    width: 3rem;
    height: 3rem;
    border: 4px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: spin 0.75s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }
</style>
