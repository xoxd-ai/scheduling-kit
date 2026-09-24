<script lang="ts">
  /**
   * VenmoCheckout Component
   * Complete Venmo payment flow with server-side order management
   *
   * This component handles:
   * 1. Loading the PayPal SDK
   * 2. Creating orders server-side
   * 3. Rendering the Venmo button
   * 4. Capturing payments after approval
   */
  import { onDestroy } from 'svelte';
  import type { PaymentIntent, PaymentResult } from '../core/types.js';

  // Props
  let {
    clientId,
    environment = 'sandbox',
    amount,
    currency = 'USD',
    description = '',
    metadata = {},
    onCreateOrder,
    onCapturePayment,
    onSuccess,
    onError,
    onCancel,
    disabled = false,
    debug = false,
  }: {
    /** PayPal Client ID */
    clientId: string;
    /** Environment (sandbox or production) */
    environment?: 'sandbox' | 'production';
    /** Amount in cents */
    amount: number;
    /** Currency code (default: USD) */
    currency?: string;
    /** Payment description */
    description?: string;
    /** Additional metadata */
    metadata?: Record<string, string>;
    /** Server-side order creation callback */
    onCreateOrder: (params: OrderCreateParams) => Promise<PaymentIntent>;
    /** Server-side payment capture callback */
    onCapturePayment: (intentId: string) => Promise<PaymentResult>;
    /** Called on successful payment */
    onSuccess: (result: PaymentResult) => void;
    /** Called on error */
    onError?: (error: Error) => void;
    /** Called when user cancels */
    onCancel?: () => void;
    /** Disable the button */
    disabled?: boolean;
    /** Enable debug logging */
    debug?: boolean;
  } = $props();

  // Types
  export interface OrderCreateParams {
    amount: number;
    currency: string;
    description: string;
    metadata: Record<string, string>;
  }

  interface PayPalNamespace {
    Buttons: (config: PayPalButtonConfig) => {
      render: (container: HTMLElement | string) => Promise<void>;
      close: () => void;
      isEligible: () => boolean;
    };
    FUNDING: {
      VENMO: string;
    };
  }

  interface PayPalButtonConfig {
    style?: {
      layout?: 'vertical' | 'horizontal';
      color?: 'gold' | 'blue' | 'silver' | 'white' | 'black';
      shape?: 'rect' | 'pill';
      label?: 'paypal' | 'checkout' | 'buynow' | 'pay' | 'installment' | 'subscribe' | 'donate';
      height?: number;
    };
    fundingSource?: string;
    createOrder: () => Promise<string>;
    onApprove: (data: { orderID: string; payerID: string }) => Promise<void>;
    onError?: (error: Error) => void;
    onCancel?: (data: { orderID: string }) => void;
  }

  // State
  let containerRef = $state<HTMLDivElement | null>(null);
  let buttonInstance: { close: () => void } | null = null;
  let initializing = false;
  let loading = $state(true);
  let processing = $state(false);
  let error = $state<string | null>(null);
  let venmoEligible = $state(true);

  // Current order tracking
  let currentOrderId = $state<string | null>(null);

  // Load PayPal SDK
  const loadPayPalSDK = (): Promise<PayPalNamespace> => {
    return new Promise((resolve, reject) => {
      // Check if already loaded
      const existingPayPal = (window as unknown as { paypal?: PayPalNamespace }).paypal;
      if (existingPayPal) {
        resolve(existingPayPal);
        return;
      }

      // Check for existing script
      const existingScript = document.querySelector(`script[src*="paypal.com/sdk/js"]`);
      if (existingScript) {
        const checkLoaded = setInterval(() => {
          const pp = (window as unknown as { paypal?: PayPalNamespace }).paypal;
          if (pp) {
            clearInterval(checkLoaded);
            resolve(pp);
          }
        }, 100);
        setTimeout(() => {
          clearInterval(checkLoaded);
          reject(new Error('PayPal SDK load timeout'));
        }, 10000);
        return;
      }

      // Create and load script
      const script = document.createElement('script');
      const params = new URLSearchParams({
        'client-id': clientId,
        'enable-funding': 'venmo',
        'disable-funding': 'card,credit,paylater',
        currency,
      });
      script.src = `https://www.paypal.com/sdk/js?${params.toString()}`;
      script.setAttribute('data-sdk-integration-source', 'scheduling-kit');
      script.async = true;

      script.onload = () => {
        const pp = (window as unknown as { paypal?: PayPalNamespace }).paypal;
        if (pp) {
          if (debug) console.log('[VenmoCheckout] PayPal SDK loaded');
          resolve(pp);
        } else {
          reject(new Error('PayPal SDK loaded but not available'));
        }
      };

      script.onerror = () => {
        reject(new Error('Failed to load PayPal SDK'));
      };

      document.head.appendChild(script);
    });
  };

  // Initialize PayPal button
  const initializeButton = async () => {
    if (!containerRef || disabled || initializing) return;
    initializing = true;

    // Clear any previously rendered button
    if (buttonInstance) {
      buttonInstance.close();
      buttonInstance = null;
    }
    if (containerRef) containerRef.innerHTML = '';

    try {
      loading = true;
      error = null;

      const paypal = await loadPayPalSDK();

      if (!containerRef) return; // Component might have unmounted

      // Check Venmo eligibility
      const buttons = paypal.Buttons({
        fundingSource: paypal.FUNDING.VENMO,
        style: {
          layout: 'vertical',
          color: 'blue',
          shape: 'rect',
          label: 'pay',
          height: 48,
        },
        createOrder: async () => {
          if (debug) console.log('[VenmoCheckout] Creating order', { amount, currency, description });

          try {
            processing = true;
            const intent = await onCreateOrder({
              amount,
              currency,
              description,
              metadata,
            });

            currentOrderId = intent.id;
            if (debug) console.log('[VenmoCheckout] Order created', intent.id);
            return intent.id;
          } catch (e) {
            const err = e instanceof Error ? e : new Error(String(e));
            error = err.message;
            onError?.(err);
            throw err;
          } finally {
            processing = false;
          }
        },
        onApprove: async (data) => {
          if (debug) console.log('[VenmoCheckout] Payment approved', data);

          try {
            processing = true;
            const result = await onCapturePayment(data.orderID);

            if (result.success) {
              if (debug) console.log('[VenmoCheckout] Payment captured', result);
              onSuccess(result);
            } else {
              throw new Error('Payment capture failed');
            }
          } catch (e) {
            const err = e instanceof Error ? e : new Error(String(e));
            error = err.message;
            onError?.(err);
          } finally {
            processing = false;
            currentOrderId = null;
          }
        },
        onError: (err) => {
          if (debug) console.error('[VenmoCheckout] Error', err);
          error = err.message || 'Payment error';
          processing = false;
          currentOrderId = null;
          onError?.(err);
        },
        onCancel: () => {
          if (debug) console.log('[VenmoCheckout] Cancelled');
          processing = false;
          currentOrderId = null;
          onCancel?.();
        },
      });

      // Check eligibility
      venmoEligible = buttons.isEligible();

      if (!venmoEligible) {
        if (debug) console.log('[VenmoCheckout] Venmo not eligible for this user');
        error = 'Venmo is not available in your browser or region.';
        loading = false;
        initializing = false;
        return;
      }

      buttonInstance = buttons;
      await buttons.render(containerRef);
      loading = false;

      if (debug) console.log('[VenmoCheckout] Button rendered');
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load payment button';
      loading = false;
      onError?.(e instanceof Error ? e : new Error(String(e)));
    } finally {
      initializing = false;
    }
  };

  // Single initialization point — $effect covers both mount and reactive changes
  $effect(() => {
    if (!disabled && containerRef && !buttonInstance) {
      initializeButton();
    }
  });

  onDestroy(() => {
    buttonInstance?.close();
  });

  // Format amount for display
  const formatPrice = (cents: number): string =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
</script>

<div class="venmo-checkout">
  <!-- Amount Display -->
  <div class="amount-display mb-4 text-center">
    <p class="text-sm text-surface-600-400">Amount due</p>
    <p class="text-2xl font-bold text-primary-600-400">{formatPrice(amount)}</p>
    {#if description}
      <p class="text-xs text-surface-400-600 mt-1">{description}</p>
    {/if}
  </div>

  <!-- Loading State -->
  {#if loading && !disabled}
    <div class="loading-state">
      <div class="skeleton-button"></div>
      <p class="loading-text">Loading Venmo...</p>
    </div>
  {/if}

  <!-- Processing State -->
  {#if processing}
    <div class="processing-state text-center py-4">
      <div class="spinner"></div>
      <p class="text-sm text-surface-600-400 mt-2">Processing payment...</p>
    </div>
  {/if}

  <!-- Error State -->
  {#if error && !processing}
    <div class="error-state bg-error-100-900 text-error-700-300 p-4 rounded-container mb-4">
      <p class="font-medium">Payment Error</p>
      <p class="text-sm mt-1">{error}</p>
      <button
        type="button"
        class="btn btn-sm preset-tonal mt-3"
        onclick={() => {
          error = null;
          initializeButton();
        }}
      >
        Try Again
      </button>
    </div>
  {/if}

  <!-- Button Container -->
  <div
    bind:this={containerRef}
    class="venmo-button-container"
    class:hidden={loading || processing || disabled || (error && !venmoEligible)}
    aria-label="Pay with Venmo"
  ></div>

  <!-- Disabled State -->
  {#if disabled}
    <div class="disabled-state text-center py-6">
      <div class="disabled-button bg-surface-200-800 rounded p-4 opacity-50">
        <p class="text-surface-600-400">Venmo Payment</p>
      </div>
      <p class="text-xs text-surface-400-600 mt-2">Complete the form to enable payment</p>
    </div>
  {/if}

  <!-- Venmo Not Available -->
  {#if !venmoEligible && !loading && !error}
    <div class="not-available text-center py-4 bg-warning-100-900 rounded-container">
      <p class="text-warning-700-300 text-sm">
        Venmo is not available in your current browser or region.
      </p>
      <p class="text-xs text-warning-600-400 mt-1">
        Please try using the Venmo mobile app or choose another payment method.
      </p>
    </div>
  {/if}

  <!-- The child owns order/capture state. Parent-owned cancellation cannot
       safely infer whether an approval or capture is in flight. -->
  {#if onCancel && !processing && !currentOrderId}
    <button
      type="button"
      class="btn btn-sm preset-tonal mt-3 w-full"
      onclick={() => { if (!processing && !currentOrderId) onCancel?.(); }}
    >
      Choose a different payment method
    </button>
  {/if}

  <!-- Security Note -->
  <p class="security-note text-xs text-surface-400-600 text-center mt-4">
    Secure payment powered by PayPal
  </p>
</div>

<style>
  .venmo-checkout {
    width: 100%;
    max-width: 400px;
    margin: 0 auto;
  }

  .loading-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
    padding: 1rem 0;
  }

  .skeleton-button {
    width: 100%;
    height: 48px;
    background: light-dark(
      linear-gradient(90deg, var(--color-surface-200) 25%, var(--color-surface-300) 50%, var(--color-surface-200) 75%),
      linear-gradient(90deg, var(--color-surface-800) 25%, var(--color-surface-700) 50%, var(--color-surface-800) 75%)
    );
    background-size: 200% 100%;
    animation: shimmer 1.5s infinite;
    border-radius: 4px;
  }

  .loading-text {
    font-size: 0.75rem;
    color: var(--color-surface-500);
  }

  .venmo-button-container {
    width: 100%;
    min-height: 48px;
  }

  .hidden {
    display: none;
  }

  .spinner {
    display: inline-block;
    width: 2rem;
    height: 2rem;
    border: 3px solid light-dark(var(--color-surface-300), var(--color-surface-700));
    border-top-color: var(--color-primary-500);
    border-radius: 50%;
    animation: spin 1s linear infinite;
  }

  @keyframes shimmer {
    0% {
      background-position: 200% 0;
    }
    100% {
      background-position: -200% 0;
    }
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
