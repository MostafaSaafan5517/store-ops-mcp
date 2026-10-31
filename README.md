# Store Ops MCP

An MCP server for a small online store: orders, products, stock and refunds, usable from
Claude, ChatGPT and other MCP clients.

**This is a demo.** It only ever works with generated demo data labelled "Demo Store".
All customers, products and orders are fake, and customer emails use `example.com`.

Status: work in progress. Read tools, write tools with human approval, a local stdio server and
a remote server for Cloudflare Workers (OAuth, GitHub and demo sign-in, consent, approval page)
are built and tested locally. The remote server is not deployed yet, and it has not yet run
against a real Postgres server (see "Not verified yet" below).

## Write tools need a human

`adjust_stock`, `cancel_order`, `issue_refund` and `add_order_note` never change anything on
the first call. They return a plain summary of the exact effect and an `approval_id`. A person
approves it (in chat when the client supports it, on the server's `/approve/<id>` page, or
locally with `pnpm run approve <id>`), and
only then does a second call with the same arguments and the `approval_id` run it, once.
Approvals expire after 10 minutes and every executed write is recorded in an append-only
audit log. Refunds go to a fake payment processor unless a Stripe test mode key is set.

## Local quick start

Requires Node 24 and pnpm.

```sh
pnpm install
pnpm seed        # creates the local Demo Store in .data/
pnpm dev:stdio   # runs the MCP server over stdio
```

Environment variables (all optional):

- `STORE_OPS_USER_ID`: the local demo user id (a UUID). Defaults to a fixed demo id.
- `STORE_OPS_DATA_DIR`: where the local PGlite database lives. Defaults to `.data/pglite`.
- `STORE_OPS_APPROVALS_DIR`: where `pnpm run approve` leaves decisions. Defaults to `.data/approvals`.
- `STORE_OPS_APPROVAL_BASE_URL`: base of approval links. Defaults to `http://localhost:8787`.
- `STRIPE_SECRET_KEY`: Stripe test mode key (`sk_test_...`). Leave unset for the fake processor.

Approve or reject a prepared action from a second terminal while the server runs:

```sh
pnpm run approve <approval_id>
pnpm run approve <approval_id> --reject
```

## Remote server (Cloudflare Workers)

`src/worker.ts` is a Worker that serves MCP over Streamable HTTP at `/mcp` and is its own OAuth
authorization server (`@cloudflare/workers-oauth-provider`):

- Discovery: `/.well-known/oauth-protected-resource/mcp` (RFC 9728, `resource` is exactly
  `<origin>/mcp`) and `/.well-known/oauth-authorization-server` (RFC 8414).
- Clients: Client ID Metadata Documents (preferred) and Dynamic Client Registration at
  `/register`. Authorization code flow with PKCE S256 at `/authorize` and `/token`. Every
  authorization response carries `iss` (RFC 9207). Refresh tokens rotate.
- Scopes: `store:read` for read tools, `store:write` for `adjust_stock`, `cancel_order` and
  `add_order_note`, plus `refunds:write` for `issue_refund`. A token without them gets a 403
  `insufficient_scope` challenge that names every scope the call needs.
- Sign-in: GitHub (a GitHub OAuth App) or "Try the demo", which creates a new demo user with its
  own Demo Store for 24 hours. The consent page shows the app, where access is sent and the
  scopes in plain words.
- Allowed redirects: `https://claude.ai/api/mcp/auth_callback`,
  `https://chatgpt.com/connector_platform_oauth_redirect` and http on `localhost` or
  `127.0.0.1` with any port (Claude Code, MCP Inspector).
- `/approve/<id>`: the signed-in user approves or rejects a prepared write.

### Run it locally

```sh
cp .dev.vars.example .dev.vars   # then set SESSION_SECRET to 32+ random characters
pnpm dev:worker                  # wrangler dev on http://localhost:8787
```

Use `http://localhost:8787` (not `127.0.0.1`): the OAuth metadata is built for the origin in
`PUBLIC_BASE_URL`. Discovery, registration and the sign-in page work without a database.
Signing in and calling tools need a local Postgres for the Hyperdrive binding's
`localConnectionString` in `wrangler.jsonc`, which comes with the Docker harness (Run 3b).

Worker settings (`.dev.vars` locally, secrets and vars in Cloudflare later):

- `PUBLIC_BASE_URL`: the public origin, no path. Also the OAuth issuer.
- `SESSION_SECRET`: 32+ characters. Signs session and CSRF cookies.
- `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`: optional. Without them only "Try the demo" shows.
- `STRIPE_SECRET_KEY`: optional, `sk_test_...` only.
- Bindings: `OAUTH_KV` (KV for OAuth state) and `HYPERDRIVE` (Postgres, Neon in production).

### Tests

`pnpm test` runs the Worker app in Node against PGlite, with small stand-ins for the Workers
runtime (`tests/support/`): an in-memory KV, the `cloudflare:workers` module and the
`global_fetch_strictly_public` flag. GitHub and CIMD documents are faked; tests never call
GitHub or Stripe. `wrangler dev` was used once to check that discovery, the 401 challenge, DCR
and the sign-in page behave the same in workerd.

### Not verified yet

- The Hyperdrive Postgres adapter and every remote flow against a real Postgres server, the
  advisory lock and `for update` proofs with parallel connections, and migrations 0002 to 0004
  on Postgres (Run 3b, Docker).
- A deployed Worker, and connecting from Claude and ChatGPT for real.
- ChatGPT's requirements come from OpenAI's Apps SDK "Authenticate users" page as read on
  2026-11-01; ChatGPT's `_meta["mcp/www_authenticate"]` tool-level signalling and tool
  `securitySchemes` are not implemented.
- GitHub PKCE support is sent (S256) but only checked against a fake GitHub.

### Demo data lifetime

Demo users stop working 24 hours after they are created (sign-in session, MCP calls and token
refresh all stop). Their stores are not deleted yet: `audit_log` is append-only and references
the store, so removing old demo stores needs a decided retention rule first. This and a rate
limit on "Try the demo" are part of the deploy step.
