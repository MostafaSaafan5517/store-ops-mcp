import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
  PostMessageTransport,
  type McpUiHostContext,
} from '@modelcontextprotocol/ext-apps/app-with-deps';

/*
 * The Store Ops dashboard view. Store data (customer names, product names, approval summaries)
 * is untrusted text: it is only ever set with textContent, never parsed as HTML.
 */

interface StockItem {
  sku: string;
  name: string;
  stock_on_hand: number;
  low_stock_threshold: number;
}

interface DashboardData {
  store: { label: string; name: string };
  period_days: number;
  from: string;
  to: string;
  generated_at: string;
  sales: {
    currency: string;
    order_count: number;
    gross_sales_cents: number;
    refunds_cents: number;
    net_sales_cents: number;
    average_order_value_cents: number;
    orders_by_status: Record<string, number>;
    top_products: { sku: string; name: string; units_sold: number; revenue_cents: number }[];
  };
  latest_orders: {
    order_number: number;
    customer_name: string;
    status: string;
    total_cents: number;
    placed_at: string;
  }[];
  stock: {
    low_stock: StockItem[];
    sold_out: StockItem[];
    low_stock_count: number;
    sold_out_count: number;
  };
  pending_approvals: {
    approval_id: string;
    tool: string;
    summary: string;
    created_at: string;
    expires_at: string;
    approval_url: string;
  }[];
}

const PERIODS = [7, 30, 90] as const;
const DATA_TOOL = 'get_dashboard_data';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let period: number = 30;
let busy = false;

function byId(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing #${id}`);
  return element;
}

/** Creates an element whose only content is plain text. */
function el(tag: string, text?: string | number, className?: string): HTMLElement {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = String(text);
  if (className) element.className = className;
  return element;
}

function setStatus(text: string, className = 'muted'): void {
  const status = byId('status');
  status.textContent = text;
  status.className = className;
}

function money(cents: number, currency: string): string {
  const amount = Number(cents) / 100;
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

function when(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? String(iso)
    : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function words(value: string): string {
  return String(value).replace(/_/g, ' ');
}

/**
 * The approval link prefix the server put in the page (`<base>/approve/`). The app opens a link
 * only when it is exactly that prefix plus an approval id; anything else is shown as text.
 */
function approvalPrefix(): string | null {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="store-ops-approval-prefix"]');
  const prefix = meta?.content ?? '';
  try {
    const url = new URL(prefix);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    const allowed = url.protocol === 'https:' || (url.protocol === 'http:' && loopback);
    return allowed && prefix.endsWith('/approve/') ? prefix : null;
  } catch {
    return null;
  }
}

function isApprovalLink(url: string, prefix: string | null): boolean {
  if (!prefix || !url.startsWith(prefix)) return false;
  return UUID.test(url.slice(prefix.length));
}

function card(label: string, value: string): HTMLElement {
  const box = el('div', undefined, 'card');
  box.append(el('div', label, 'label'), el('div', value, 'value'));
  return box;
}

function table(headers: { text: string; num?: boolean }[], rows: (string | number)[][]) {
  const wrap = el('div', undefined, 'table-wrap');
  const tableEl = el('table');
  const head = el('tr');
  for (const header of headers) head.append(el('th', header.text, header.num ? 'num' : undefined));
  const thead = el('thead');
  thead.append(head);
  const tbody = el('tbody');
  for (const row of rows) {
    const tr = el('tr');
    row.forEach((cell, index) =>
      tr.append(el('td', cell, headers[index]?.num ? 'num' : undefined)),
    );
    tbody.append(tr);
  }
  tableEl.append(thead, tbody);
  wrap.append(tableEl);
  return wrap;
}

function stockList(items: StockItem[], empty: string, className: string): HTMLElement {
  const list = el('ul');
  if (items.length === 0) list.append(el('li', empty, 'muted'));
  for (const item of items) {
    const li = el('li');
    li.append(
      el('span', item.name),
      el('span', ` (${item.sku}) `, 'muted'),
      el('span', `${item.stock_on_hand} on hand, alert at ${item.low_stock_threshold}`, className),
    );
    list.append(li);
  }
  return list;
}

function approvalsList(app: App, data: DashboardData): HTMLElement {
  const list = el('ul');
  if (data.pending_approvals.length === 0) {
    list.append(el('li', 'Nothing is waiting for approval.', 'muted'));
  }
  const prefix = approvalPrefix();
  for (const approval of data.pending_approvals) {
    const li = el('li', undefined, 'approval');
    li.append(
      el('div', approval.summary),
      el(
        'div',
        `${words(approval.tool)}, prepared ${when(approval.created_at)}, expires ${when(approval.expires_at)}`,
        'muted',
      ),
    );
    const actions = el('div', undefined, 'actions');
    const url = String(approval.approval_url);
    if (isApprovalLink(url, prefix)) {
      const button = el('button', 'Open approval page');
      button.setAttribute('type', 'button');
      button.addEventListener('click', () => {
        app
          .openLink({ url })
          .then((result) => {
            if (result.isError) showLinkAsText(actions, url, 'The host did not open the link.');
          })
          .catch(() => showLinkAsText(actions, url, 'The host did not open the link.'));
      });
      actions.append(button);
    } else {
      showLinkAsText(actions, url, 'This link is not on this server, so it is not opened:');
    }
    li.append(actions);
    list.append(li);
  }
  return list;
}

function showLinkAsText(container: HTMLElement, url: string, message: string): void {
  container.replaceChildren(el('div', message, 'warn'), el('div', url, 'url'));
}

function render(app: App, data: DashboardData): void {
  period = data.period_days;
  byId('store-name').textContent = data.store.name;
  renderControls(app);
  const { sales } = data;
  const root = byId('dashboard');
  const sections: HTMLElement[] = [];

  sections.push(el('h2', `Sales, last ${data.period_days} days (${data.from} to ${data.to})`));
  const cards = el('div', undefined, 'cards');
  cards.append(
    card('Gross sales', money(sales.gross_sales_cents, sales.currency)),
    card('Refunds', money(sales.refunds_cents, sales.currency)),
    card('Net sales', money(sales.net_sales_cents, sales.currency)),
    card('Orders', String(sales.order_count)),
    card('Average order', money(sales.average_order_value_cents, sales.currency)),
  );
  sections.push(cards);

  sections.push(el('h2', 'Orders by status'));
  const chips = el('div', undefined, 'chips');
  for (const [status, count] of Object.entries(sales.orders_by_status)) {
    chips.append(el('span', `${words(status)}: ${count}`, 'chip'));
  }
  sections.push(chips);

  sections.push(el('h2', 'Top products'));
  sections.push(
    sales.top_products.length === 0
      ? el('p', 'No sales in this period.', 'muted')
      : table(
          [{ text: 'Product' }, { text: 'Units', num: true }, { text: 'Revenue', num: true }],
          sales.top_products.map((product) => [
            product.name,
            product.units_sold,
            money(product.revenue_cents, sales.currency),
          ]),
        ),
  );

  sections.push(el('h2', 'Latest orders'));
  sections.push(
    table(
      [
        { text: 'Order' },
        { text: 'Customer' },
        { text: 'Status' },
        { text: 'Total', num: true },
        { text: 'Placed' },
      ],
      data.latest_orders.map((order) => [
        `#${order.order_number}`,
        order.customer_name,
        words(order.status),
        money(order.total_cents, sales.currency),
        when(order.placed_at),
      ]),
    ),
  );

  sections.push(el('h2', `Low stock (${data.stock.low_stock_count})`));
  sections.push(stockList(data.stock.low_stock, 'Nothing is low on stock.', 'warn'));
  sections.push(el('h2', `Sold out (${data.stock.sold_out_count})`));
  sections.push(stockList(data.stock.sold_out, 'Nothing is sold out.', 'danger'));

  sections.push(el('h2', 'Waiting for approval'));
  sections.push(
    el(
      'p',
      'Actions are approved only on the approval page, never in this dashboard. After you approve, ask the assistant to run the action, then press Refresh.',
      'muted',
    ),
  );
  sections.push(approvalsList(app, data));

  root.replaceChildren(...sections);
  setStatus(`Updated ${when(data.generated_at)}`);
}

function renderControls(app: App): void {
  const controls = byId('controls');
  const buttons = PERIODS.map((days) => {
    const button = el('button', `${days} days`);
    button.setAttribute('type', 'button');
    button.setAttribute('aria-pressed', String(days === period));
    button.addEventListener('click', () => void load(app, days));
    return button;
  });
  const refresh = el('button', 'Refresh');
  refresh.setAttribute('type', 'button');
  refresh.addEventListener('click', () => void load(app, period));
  controls.replaceChildren(...buttons, refresh);
  for (const button of controls.querySelectorAll('button')) button.disabled = busy;
}

function isDashboardData(value: unknown): value is DashboardData {
  if (typeof value !== 'object' || value === null) return false;
  const data = value as Partial<DashboardData>;
  return (
    typeof data.store?.name === 'string' &&
    typeof data.sales?.currency === 'string' &&
    Array.isArray(data.latest_orders) &&
    Array.isArray(data.stock?.low_stock) &&
    Array.isArray(data.stock?.sold_out) &&
    Array.isArray(data.pending_approvals)
  );
}

function errorText(result: { content?: unknown }): string {
  const blocks = Array.isArray(result.content) ? (result.content as unknown[]) : [];
  const first = blocks.find(
    (block): block is { type: 'text'; text: string } =>
      typeof block === 'object' &&
      block !== null &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string',
  );
  return first?.text ?? 'The dashboard could not be loaded.';
}

interface ToolOutcome {
  content?: unknown;
  structuredContent?: unknown;
  isError?: boolean | undefined;
}

function show(app: App, result: ToolOutcome): void {
  if (!result.isError && isDashboardData(result.structuredContent)) {
    render(app, result.structuredContent);
  } else {
    setStatus(errorText(result), 'danger');
  }
}

async function load(app: App, days: number): Promise<void> {
  busy = true;
  period = days;
  renderControls(app);
  setStatus('Loading...');
  try {
    show(app, await app.callServerTool({ name: DATA_TOOL, arguments: { period_days: days } }));
  } catch {
    setStatus('The host could not reach the server. Try Refresh again.', 'danger');
  } finally {
    busy = false;
    renderControls(app);
  }
}

function applyHostContext(context: McpUiHostContext | undefined): void {
  if (context?.theme) applyDocumentTheme(context.theme);
  if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables);
}

const app = new App({ name: 'store-ops-dashboard', version: '1.0.0' });
app.ontoolinput = (params) => {
  const requested = Number(params.arguments?.period_days);
  if ((PERIODS as readonly number[]).includes(requested)) period = requested;
};
app.ontoolresult = (params) => show(app, params);
app.onhostcontextchanged = (params) => applyHostContext(params);
renderControls(app);

app
  .connect(new PostMessageTransport(window.parent, window.parent))
  .then(() => applyHostContext(app.getHostContext()))
  .catch(() => setStatus('Could not connect to the host.', 'danger'));
