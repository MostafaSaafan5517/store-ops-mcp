import { createFakePayments } from './fake.js';
import { createStripeTestPayments } from './stripe.js';
import type { PaymentsAdapter } from './types.js';

/**
 * Demo orders carry fake payment references, so refunds use the fake processor unless a
 * Stripe test key is configured. A key that is set but not `sk_test_` is an error, never a
 * silent fallback.
 */
export function selectPayments(env: Record<string, string | undefined>): PaymentsAdapter {
  const secretKey = env.STRIPE_SECRET_KEY?.trim();
  return secretKey ? createStripeTestPayments({ secretKey }) : createFakePayments();
}
