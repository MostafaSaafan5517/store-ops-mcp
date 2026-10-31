import Stripe from 'stripe';
import { PaymentError, type PaymentsAdapter, type RefundOutcome } from './types.js';

export interface StripeTestPaymentsOptions {
  secretKey: string;
  /** Injected in tests so no request ever reaches Stripe. Defaults to the global fetch. */
  fetch?: typeof fetch;
}

const STRIPE_PAYMENT_INTENT = /^pi_[A-Za-z0-9]+$/;

function toOutcome(refund: Stripe.Refund): RefundOutcome {
  const status =
    refund.status === 'succeeded'
      ? 'succeeded'
      : refund.status === 'failed' || refund.status === 'canceled'
        ? 'failed'
        : 'pending';
  return { providerRefundId: refund.id, status };
}

/**
 * Real Stripe refunds, test mode only. Refuses any key that is not a `sk_test_` secret key,
 * and sends the approval id as the Idempotency-Key so a retried execution is one refund.
 */
export function createStripeTestPayments(options: StripeTestPaymentsOptions): PaymentsAdapter {
  if (!options.secretKey.startsWith('sk_test_')) {
    throw new Error('Only Stripe test mode secret keys (sk_test_...) are accepted.');
  }
  const stripe = new Stripe(options.secretKey, {
    httpClient: Stripe.createFetchHttpClient(options.fetch ?? fetch),
    maxNetworkRetries: 2,
    telemetry: false,
  });
  return {
    processor: 'stripe_test_mode',
    async refund(request) {
      if (!STRIPE_PAYMENT_INTENT.test(request.paymentReference)) {
        throw new PaymentError(
          `Payment ${request.paymentReference} is demo data, not a Stripe PaymentIntent, so Stripe cannot refund it. Unset STRIPE_SECRET_KEY to refund demo orders with the fake processor.`,
        );
      }
      try {
        const refund = await stripe.refunds.create(
          {
            payment_intent: request.paymentReference,
            amount: request.amountCents,
            reason: 'requested_by_customer',
            metadata: { approval_id: request.idempotencyKey, reason: request.reason },
          },
          { idempotencyKey: request.idempotencyKey },
        );
        return toOutcome(refund);
      } catch (error) {
        if (error instanceof Stripe.errors.StripeError) {
          throw new PaymentError(`Stripe (test mode) refused the refund: ${error.message}`);
        }
        throw error;
      }
    },
  };
}
