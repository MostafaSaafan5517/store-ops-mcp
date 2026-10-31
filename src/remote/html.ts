import { PRODUCT_NAME } from '../config.js';

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** Headers for every page: no framing, no caching, no scripts, nothing loaded from elsewhere. */
export function pageHeaders(extra?: Headers): Headers {
  const headers = new Headers(extra);
  headers.set('Content-Type', 'text/html; charset=utf-8');
  headers.set(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
  );
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Cache-Control', 'no-store');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Content-Type-Options', 'nosniff');
  return headers;
}

const STYLE = `
  body { font-family: system-ui, sans-serif; max-width: 34rem; margin: 3rem auto; padding: 0 1rem; line-height: 1.5; color: #1d1d1f; }
  h1 { font-size: 1.4rem; }
  .demo { display: inline-block; background: #fff4cc; border: 1px solid #e0c060; border-radius: 4px; padding: 0 .4rem; font-size: .85rem; }
  .warning { background: #fff0f0; border: 1px solid #e0a0a0; border-radius: 6px; padding: .6rem .8rem; }
  .box { background: #f5f5f7; border-radius: 6px; padding: .6rem .8rem; }
  pre { white-space: pre-wrap; word-break: break-word; font-size: .85rem; }
  form { display: inline-block; margin: .5rem .5rem 0 0; }
  button { font-size: 1rem; padding: .45rem 1rem; border-radius: 6px; border: 1px solid #888; background: #fff; cursor: pointer; }
  button.primary { background: #1d1d1f; color: #fff; border-color: #1d1d1f; }
  footer { margin-top: 2rem; font-size: .8rem; color: #666; }
`;

/** A complete HTML page. `body` must already be escaped. */
export function renderPage(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} | ${escapeHtml(PRODUCT_NAME)}</title>
<style>${STYLE}</style>
</head>
<body>
<p><strong>${escapeHtml(PRODUCT_NAME)}</strong> <span class="demo">Demo Store, demo data only</span></p>
${body}
<footer>All data here is generated demo data. Nothing is a real shop, customer or payment.</footer>
</body>
</html>`;
}

export function htmlResponse(
  title: string,
  body: string,
  init: { status?: number; headers?: Headers } = {},
): Response {
  return new Response(renderPage(title, body), {
    status: init.status ?? 200,
    headers: pageHeaders(init.headers),
  });
}

/** A hidden CSRF field for a form. */
export function csrfField(token: string): string {
  return `<input type="hidden" name="csrf" value="${escapeHtml(token)}">`;
}
