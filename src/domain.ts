export const ORDER_STATUSES = [
  'pending',
  'paid',
  'fulfilled',
  'cancelled',
  'partially_refunded',
  'refunded',
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Orders that count as sales: money was taken (refunds are subtracted separately). */
export const SALE_STATUSES: readonly OrderStatus[] = [
  'paid',
  'fulfilled',
  'partially_refunded',
  'refunded',
];

/** Only unpaid orders can be cancelled. A paid order is refunded instead (issue_refund). */
export const CANCELLABLE_STATUSES: readonly OrderStatus[] = ['pending'];

/** Orders that were paid and still have money that can be refunded. */
export const REFUNDABLE_STATUSES: readonly OrderStatus[] = [
  'paid',
  'fulfilled',
  'partially_refunded',
];

/** Refund statuses that count against the refundable amount (money is gone or on its way). */
export const COMMITTED_REFUND_STATUSES = ['pending', 'succeeded'] as const;

/** Plain money text for summaries shown to people, for example "USD 12.50". */
export function formatMoney(cents: number, currency: string): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${currency} ${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
