import type { WriteToolName } from '../approvals.js';

export const SCOPES = ['store:read', 'store:write', 'refunds:write'] as const;

export type Scope = (typeof SCOPES)[number];

/** Needed for any access to the MCP endpoint. Clients request it first. */
export const BASELINE_SCOPE: Scope = 'store:read';

/** Plain words for the consent page. */
export const SCOPE_DESCRIPTIONS: Record<Scope, string> = {
  'store:read': 'See orders, customers, products, stock levels and sales in your Demo Store.',
  'store:write':
    'Prepare stock adjustments, order cancellations and order notes. Each one still needs your approval before it runs.',
  'refunds:write':
    'Prepare refunds (fake payments, or Stripe test mode). Each refund still needs your approval before it runs.',
};

const WRITE_TOOL_SCOPES: Record<WriteToolName, readonly Scope[]> = {
  adjust_stock: ['store:read', 'store:write'],
  cancel_order: ['store:read', 'store:write'],
  add_order_note: ['store:read', 'store:write'],
  issue_refund: ['store:read', 'store:write', 'refunds:write'],
};

export function isScope(value: string): value is Scope {
  return (SCOPES as readonly string[]).includes(value);
}

/** Every scope a tool call needs. Read tools and unknown names need only the baseline. */
export function scopesForTool(name: string): readonly Scope[] {
  return Object.hasOwn(WRITE_TOOL_SCOPES, name)
    ? WRITE_TOOL_SCOPES[name as WriteToolName]
    : [BASELINE_SCOPE];
}

function toolCallNames(message: unknown): string[] {
  if (typeof message !== 'object' || message === null) return [];
  const { method, params } = message as { method?: unknown; params?: unknown };
  if (method !== 'tools/call' || typeof params !== 'object' || params === null) return [];
  const name = (params as { name?: unknown }).name;
  return typeof name === 'string' ? [name] : [];
}

/**
 * The scopes one MCP HTTP request needs, from its JSON-RPC body (one message or a batch) and
 * the 2026-07-28 `Mcp-Method` and `Mcp-Name` headers. Both are read and the union is
 * required, so a header that disagrees with the body can only ask for more, never less.
 */
export function scopesForRequest(body: unknown, headers: Headers): Scope[] {
  const names = (Array.isArray(body) ? body : [body]).flatMap(toolCallNames);
  const headerName = headers.get('mcp-name');
  if (headers.get('mcp-method') === 'tools/call' && headerName) names.push(headerName);
  const needed = new Set<Scope>([BASELINE_SCOPE]);
  for (const name of names) for (const scope of scopesForTool(name)) needed.add(scope);
  return SCOPES.filter((scope) => needed.has(scope));
}
