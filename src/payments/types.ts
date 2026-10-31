/** What the refund tool asks a payment processor to do. Money is integer cents. */
export interface RefundRequest {
  /** The order's payment reference, for example a Stripe PaymentIntent id. */
  paymentReference: string;
  amountCents: number;
  currency: string;
  /** The approval id. The processor must treat repeats with the same key as one refund. */
  idempotencyKey: string;
  reason: string;
}

export interface RefundOutcome {
  providerRefundId: string;
  status: 'pending' | 'succeeded' | 'failed';
}

export interface PaymentsAdapter {
  /** Shown in tool results so it is always clear whether real (test mode) Stripe was used. */
  readonly processor: 'fake' | 'stripe_test_mode';
  refund(request: RefundRequest): Promise<RefundOutcome>;
}

/** A processor refusal whose message is safe to show to the client. */
export class PaymentError extends Error {}
