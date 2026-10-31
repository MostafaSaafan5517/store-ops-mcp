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
