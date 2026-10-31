import { DEFAULT_CURRENCY, DEMO_STORE_NAME } from '../config.js';
import type { OrderStatus } from '../domain.js';
import {
  CATALOG,
  CUSTOMER_NOTES,
  FAKE_SURNAMES,
  FIRST_NAMES,
  INSTRUCTION_LIKE_NOTE,
  REFUND_REASONS,
} from './catalog.js';
import { createRandom, type Random } from './random.js';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export interface DemoProduct {
  sku: string;
  name: string;
  category: string;
  priceCents: number;
  stockOnHand: number;
  lowStockThreshold: number;
}

export interface DemoCustomer {
  name: string;
  email: string;
}

export interface DemoOrderItem {
  productIndex: number;
  quantity: number;
  unitPriceCents: number;
  lineTotalCents: number;
}

export interface DemoRefund {
  amountCents: number;
  reason: string;
  providerRefundId: string;
  createdAt: Date;
}

export interface DemoNote {
  author: 'customer' | 'staff';
  body: string;
  createdAt: Date;
}

export interface DemoOrder {
  orderNumber: number;
  customerIndex: number;
  status: OrderStatus;
  items: DemoOrderItem[];
  subtotalCents: number;
  shippingCents: number;
  taxCents: number;
  totalCents: number;
  paymentMethod: string | null;
  paymentReference: string | null;
  placedAt: Date;
  paidAt: Date | null;
  fulfilledAt: Date | null;
  cancelledAt: Date | null;
  refunds: DemoRefund[];
  notes: DemoNote[];
}

export interface DemoStoreData {
  name: string;
  currency: string;
  products: DemoProduct[];
  customers: DemoCustomer[];
  orders: DemoOrder[];
}

export interface DemoStoreOptions {
  /** Same seed and same `now` always give the same store. Use the user id per user. */
  seed: string;
  now: Date;
  orderCount?: number;
  customerCount?: number;
  historyDays?: number;
}

export const FIRST_ORDER_NUMBER = 1001;
const FREE_SHIPPING_FROM_CENTS = 5000;
const SHIPPING_CENTS = 595;
const TAX_RATE = 0.08;
const LOW_STOCK_THRESHOLD = 5;
const LOW_STOCK_PRODUCT_COUNT = 6;
/** The newest orders are always still pending, so every store shows the full status mix. */
const NEWEST_PENDING_ORDERS = 3;

function buildProducts(random: Random): DemoProduct[] {
  const products: DemoProduct[] = [];
  for (const [category, { prefix, items }] of Object.entries(CATALOG)) {
    items.forEach((item, index) => {
      products.push({
        sku: `${prefix}-${String(index + 1).padStart(3, '0')}`,
        name: item.name,
        category,
        priceCents: item.priceCents,
        stockOnHand: random.int(20, 140),
        lowStockThreshold: LOW_STOCK_THRESHOLD,
      });
    });
  }
  // A few products sit at or below the threshold, two of them sold out.
  const lowStockIndexes = new Set<number>();
  while (lowStockIndexes.size < LOW_STOCK_PRODUCT_COUNT) {
    lowStockIndexes.add(random.int(0, products.length - 1));
  }
  [...lowStockIndexes].forEach((productIndex, position) => {
    const product = products[productIndex];
    if (product) product.stockOnHand = position < 2 ? 0 : random.int(1, LOW_STOCK_THRESHOLD);
  });
  return products;
}

function buildCustomers(count: number): DemoCustomer[] {
  return Array.from({ length: count }, (_, index) => {
    const first = FIRST_NAMES[index % FIRST_NAMES.length] ?? 'Avery';
    const last =
      FAKE_SURNAMES[(index * 3 + Math.floor(index / FIRST_NAMES.length)) % FAKE_SURNAMES.length] ??
      'Sampleton';
    return {
      name: `${first} ${last}`,
      email: `${first}.${last}${index + 1}@example.com`.toLowerCase(),
    };
  });
}

function pickStatus(random: Random, ageDays: number): OrderStatus {
  const roll = random.next();
  if (ageDays < 2) return roll < 0.4 ? 'pending' : roll < 0.9 ? 'paid' : 'cancelled';
  if (ageDays < 7) {
    if (roll < 0.05) return 'pending';
    if (roll < 0.45) return 'paid';
    return roll < 0.9 ? 'fulfilled' : 'cancelled';
  }
  if (roll < 0.78) return 'fulfilled';
  if (roll < 0.84) return 'cancelled';
  return roll < 0.9 ? 'refunded' : 'partially_refunded';
}

function minDate(a: Date, b: Date): Date {
  return a.getTime() <= b.getTime() ? a : b;
}

function buildItems(random: Random, products: DemoProduct[]): DemoOrderItem[] {
  const lineCount = random.int(1, 3);
  const used = new Set<number>();
  const items: DemoOrderItem[] = [];
  while (items.length < lineCount) {
    const productIndex = random.int(0, products.length - 1);
    if (used.has(productIndex)) continue;
    used.add(productIndex);
    const unitPriceCents = products[productIndex]?.priceCents ?? 0;
    const quantity = random.int(1, 3);
    items.push({
      productIndex,
      quantity,
      unitPriceCents,
      lineTotalCents: quantity * unitPriceCents,
    });
  }
  return items;
}

/** Pure, deterministic description of one demo store. No ids, no database access. */
export function generateDemoStore(options: DemoStoreOptions): DemoStoreData {
  const random = createRandom(options.seed);
  const orderCount = options.orderCount ?? 200;
  const historyDays = options.historyDays ?? 90;
  const nowMs = Math.floor(options.now.getTime() / 60_000) * 60_000;
  const now = new Date(nowMs);

  const products = buildProducts(random);
  const customers = buildCustomers(options.customerCount ?? 60);

  const placedTimes = Array.from(
    { length: orderCount },
    () => nowMs - Math.floor(random.next() * historyDays * 24 * 60) * 60_000,
  ).sort((a, b) => a - b);
  const instructionNoteAt = Math.floor(orderCount / 3);

  const orders = placedTimes.map((placedMs, index): DemoOrder => {
    const placedAt = new Date(placedMs);
    const ageDays = (nowMs - placedMs) / DAY_MS;
    const status =
      index >= orderCount - NEWEST_PENDING_ORDERS ? 'pending' : pickStatus(random, ageDays);
    const items = buildItems(random, products);
    const subtotalCents = items.reduce((sum, item) => sum + item.lineTotalCents, 0);
    const shippingCents = subtotalCents >= FREE_SHIPPING_FROM_CENTS ? 0 : SHIPPING_CENTS;
    const taxCents = Math.round(subtotalCents * TAX_RATE);
    const totalCents = subtotalCents + shippingCents + taxCents;
    const orderNumber = FIRST_ORDER_NUMBER + index;

    const isPaid = status !== 'pending' && status !== 'cancelled';
    const paidAt = isPaid ? new Date(placedMs + random.int(1, 30) * 60_000) : null;
    const isFulfilled =
      status === 'fulfilled' || status === 'refunded' || status === 'partially_refunded';
    const fulfilledAt =
      isFulfilled && paidAt
        ? minDate(new Date(paidAt.getTime() + random.int(20, 72) * HOUR_MS), now)
        : null;
    const cancelledAt =
      status === 'cancelled' ? minDate(new Date(placedMs + random.int(1, 6) * HOUR_MS), now) : null;

    const notes: DemoNote[] = [];
    if (index === instructionNoteAt) {
      notes.push({ author: 'customer', body: INSTRUCTION_LIKE_NOTE, createdAt: placedAt });
    } else if (random.chance(0.15)) {
      notes.push({ author: 'customer', body: random.pick(CUSTOMER_NOTES), createdAt: placedAt });
    }

    const refunds: DemoRefund[] = [];
    if ((status === 'refunded' || status === 'partially_refunded') && fulfilledAt) {
      const firstLine = items[0]?.lineTotalCents ?? 0;
      const amountCents = status === 'refunded' || firstLine >= totalCents ? totalCents : firstLine;
      const reason = random.pick(REFUND_REASONS);
      const createdAt = minDate(new Date(fulfilledAt.getTime() + random.int(1, 4) * DAY_MS), now);
      refunds.push({ amountCents, reason, providerRefundId: `re_demo_${orderNumber}`, createdAt });
      notes.push({ author: 'staff', body: `Refund issued: ${reason}`, createdAt });
    }

    return {
      orderNumber,
      customerIndex: random.int(0, customers.length - 1),
      status: refunds[0]?.amountCents === totalCents ? 'refunded' : status,
      items,
      subtotalCents,
      shippingCents,
      taxCents,
      totalCents,
      paymentMethod: paidAt ? 'card' : null,
      paymentReference: paidAt ? `pi_demo_${orderNumber}` : null,
      placedAt,
      paidAt,
      fulfilledAt,
      cancelledAt,
      refunds,
      notes,
    };
  });

  return { name: DEMO_STORE_NAME, currency: DEFAULT_CURRENCY, products, customers, orders };
}
