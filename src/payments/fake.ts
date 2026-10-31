import type { PaymentsAdapter, RefundOutcome, RefundRequest } from './types.js';

export interface FakePayments extends PaymentsAdapter {
  /** Every refund call received, including repeats of the same idempotency key. */
  readonly calls: RefundRequest[];
}

/**
 * In-memory processor used by all tests and by demo mode without a Stripe key. Like Stripe,
 * it returns the first outcome again when an idempotency key repeats.
 */
export function createFakePayments(): FakePayments {
  const calls: RefundRequest[] = [];
  const byKey = new Map<string, RefundOutcome>();
  return {
    processor: 'fake',
    calls,
    refund(request) {
      calls.push(request);
      const existing = byKey.get(request.idempotencyKey);
      if (existing) return Promise.resolve(existing);
      const outcome: RefundOutcome = {
        providerRefundId: `re_fake_${request.idempotencyKey.replace(/-/g, '')}`,
        status: 'succeeded',
      };
      byKey.set(request.idempotencyKey, outcome);
      return Promise.resolve(outcome);
    },
  };
}
