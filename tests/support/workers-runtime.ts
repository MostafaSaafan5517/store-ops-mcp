// Runtime facts the OAuth provider reads from the Workers global scope. In production these
// come from wrangler.jsonc (compatibility_flags). CIMD needs global_fetch_strictly_public.
Object.assign(globalThis, {
  Cloudflare: { compatibilityFlags: { global_fetch_strictly_public: true } },
});
