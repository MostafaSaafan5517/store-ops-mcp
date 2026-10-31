import { describe, expect, it } from 'vitest';
import { createFakePayments } from '../src/payments/fake.js';
import { selectPayments } from '../src/payments/select.js';
import { createStripeTestPayments } from '../src/payments/stripe.js';
import { PaymentError, type RefundRequest } from '../src/payments/types.js';

const REQUEST: RefundRequest = {
  paymentReference: 'pi_3TestPaymentIntent',
  amountCents: 1500,
  currency: 'USD',
  idempotencyKey: '0b9a3c4e-6d1f-4a2b-9c3d-5e6f7a8b9c0d',
  reason: 'Damaged on arrival',
};

interface RecordedRequest {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}

/** A fetch stand-in that records requests and answers like the Stripe refunds endpoint. */
function recordingFetch(status = 'succeeded') {
  const requests: RecordedRequest[] = [];
  const fetchFn = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    requests.push({
      url: input instanceof Request ? input.url : input.toString(),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : '',
    });
    return Promise.resolve(
      new Response(JSON.stringify({ id: 're_test_123', object: 'refund', status, amount: 1500 }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'request-id': 'req_test' },
      }),
    );
  };
  return { requests, fetch: fetchFn };
}

describe('fake payments', () => {
  it('refunds and returns the same outcome when the idempotency key repeats', async () => {
    const payments = createFakePayments();
    const first = await payments.refund(REQUEST);
    const again = await payments.refund(REQUEST);
    const other = await payments.refund({ ...REQUEST, idempotencyKey: 'another-key' });
    expect(first.status).toBe('succeeded');
    expect(again).toEqual(first);
    expect(other.providerRefundId).not.toBe(first.providerRefundId);
    expect(payments.calls).toHaveLength(3);
  });
});

describe('Stripe test mode payments', () => {
  it.each(['sk_live_abc', 'rk_test_abc', 'pk_test_abc', '', 'SK_TEST_abc'])(
    'refuses the key %j',
    (secretKey) => {
      expect(() => createStripeTestPayments({ secretKey })).toThrow(/sk_test_/);
    },
  );

  it('sends the approval id as the Idempotency-Key and the amount in cents', async () => {
    const recorder = recordingFetch();
    const payments = createStripeTestPayments({
      secretKey: 'sk_test_unit',
      fetch: recorder.fetch,
    });
    const outcome = await payments.refund(REQUEST);
    expect(outcome).toEqual({ providerRefundId: 're_test_123', status: 'succeeded' });
    expect(recorder.requests).toHaveLength(1);
    const sent = recorder.requests[0];
    expect(sent?.url).toBe('https://api.stripe.com/v1/refunds');
    expect(sent?.method).toBe('POST');
    expect(sent?.headers.get('idempotency-key')).toBe(REQUEST.idempotencyKey);
    const body = new URLSearchParams(sent?.body);
    expect(body.get('payment_intent')).toBe(REQUEST.paymentReference);
    expect(body.get('amount')).toBe('1500');
    expect(body.get('metadata[approval_id]')).toBe(REQUEST.idempotencyKey);
  });

  it('maps a failed Stripe refund to a failed outcome', async () => {
    const recorder = recordingFetch('failed');
    const payments = createStripeTestPayments({ secretKey: 'sk_test_unit', fetch: recorder.fetch });
    expect((await payments.refund(REQUEST)).status).toBe('failed');
  });

  it('refuses demo payment references without calling Stripe', async () => {
    const recorder = recordingFetch();
    const payments = createStripeTestPayments({ secretKey: 'sk_test_unit', fetch: recorder.fetch });
    await expect(
      payments.refund({ ...REQUEST, paymentReference: 'pi_demo_1001' }),
    ).rejects.toBeInstanceOf(PaymentError);
    expect(recorder.requests).toHaveLength(0);
  });
});

describe('selectPayments', () => {
  it('uses the fake processor when no Stripe key is set', () => {
    expect(selectPayments({}).processor).toBe('fake');
    expect(selectPayments({ STRIPE_SECRET_KEY: '  ' }).processor).toBe('fake');
  });

  it('uses Stripe test mode for a test key and refuses a live key', () => {
    expect(selectPayments({ STRIPE_SECRET_KEY: 'sk_test_unit' }).processor).toBe(
      'stripe_test_mode',
    );
    expect(() => selectPayments({ STRIPE_SECRET_KEY: 'sk_live_unit' })).toThrow(/sk_test_/);
  });
});
