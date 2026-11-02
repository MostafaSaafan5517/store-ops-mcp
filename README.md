# Store Ops MCP

An MCP server for a small online store: orders, products, stock and refunds, usable from
Claude, ChatGPT and other MCP clients.

**This is a demo.** It only ever works with generated demo data labelled "Demo Store". There is
no real shop, brand, customer or payment behind it. Customer emails use `example.com`, and
refunds go to a fake payment processor (or Stripe test mode, never live mode).

What it shows: an AI assistant can read a store's data and prepare changes, but nothing changes
until a person approves the exact action, every change is recorded in an append-only audit log,
and each user only ever sees their own store.

Status: live demo at **https://store-ops-mcp.mostafawork5517.workers.dev** (MCP endpoint:
`/mcp`), on Cloudflare Workers with Neon Postgres 17 through Hyperdrive. Tested locally on PGlite
and Postgres 17, in CI, and end to end against the deployed server (see
[Verified on the live server](#verified-on-the-live-server) and [Not verified yet](#not-verified-yet)).

## Architecture

```mermaid
flowchart LR
  subgraph Clients
    CD[Claude Desktop / Claude Code<br/>stdio]
    RC[Claude, ChatGPT,<br/>MCP Inspector<br/>Streamable HTTP]
    BR[Browser<br/>sign-in, consent,<br/>approval page]
  end

  subgraph Local
    STDIO[src/stdio.ts]
    PGL[(PGlite<br/>.data/pglite)]
  end

  subgraph Worker[Cloudflare Worker: src/worker.ts]
    OAUTH[OAuth provider<br/>discovery, DCR, CIMD,<br/>/authorize, /token]
    MCP[/mcp<br/>scope check per tool/]
    PAGES[/login, /authorize,<br/>/approve/id/]
    CRON[Cron Trigger<br/>hourly cleanup]
  end

  SERVER[createStoreOpsServer<br/>10 tools + approval flow]
  KV[(Workers KV<br/>OAuth grants and tokens)]
  RL[[Rate Limiting binding]]
  PG[(Postgres with RLS<br/>Neon via Hyperdrive)]

  CD --> STDIO --> SERVER
  SERVER --> PGL
  RC --> OAUTH
  RC --> MCP --> SERVER
  BR --> PAGES
  OAUTH --- KV
  PAGES --- RL
  SERVER --> PG
  PAGES --> PG
  CRON --> PG
  CRON --> KV
```

Every database call runs in one transaction as the non-owner role `store_ops_app`, with the
user and store taken from the auth context (never from tool arguments). Row level security
does the rest.

## Tools

| Tool                | Kind  | Scopes needed                          | What it does                                                   |
| ------------------- | ----- | -------------------------------------- | -------------------------------------------------------------- |
| `list_orders`       | read  | `store:read`                           | Orders, newest first, filtered by status and date range        |
| `search_orders`     | read  | `store:read`                           | Find orders by number, customer name or email                  |
| `get_order`         | read  | `store:read`                           | One order with items, notes and refunds                        |
| `search_products`   | read  | `store:read`                           | Products by name or SKU and/or category                        |
| `get_stock_levels`  | read  | `store:read`                           | Stock on hand, low stock first                                 |
| `get_sales_summary` | read  | `store:read`                           | Sales, refunds, net sales and top products for a period        |
| `adjust_stock`      | write | `store:read store:write`               | Change stock on hand by a number of units, with a reason       |
| `cancel_order`      | write | `store:read store:write`               | Cancel an unpaid (pending) order and put its stock back        |
| `add_order_note`    | write | `store:read store:write`               | Add a staff note to an order                                   |
| `issue_refund`      | write | `store:read store:write refunds:write` | Refund part or all of a paid order through the payment adapter |

Read tools carry `readOnlyHint: true`. Write tools carry `destructiveHint` where it applies.
Lists use opaque cursors and a `limit` of at most 50. Money is always integer cents.

## The approval flow

Write tools never change anything on the first call.

1. The assistant calls a write tool, for example `adjust_stock` with a SKU, a quantity and a
   reason. The server checks it against the store and stores a pending approval bound to the
   user, the store, the tool and a SHA-256 hash of the exact arguments. It expires in 10
   minutes.
2. The tool returns `approval_required` with a plain summary of the exact effect and an
   `approval_url`. An in-chat confirmation (form elicitation) exists but is off by default
   (`inChatConfirmation`): the Claude desktop app declared elicitation yet showed nothing, so the
   call stalled. The approval link works in every client.
3. The person opens the link, signs in if needed, reads the summary and clicks Approve or
   Reject. Locally, `pnpm run approve <approval_id>` does the same.
4. The assistant calls the tool again with the same arguments and the `approval_id`. In one
   transaction the server locks the approval, checks tool, hash, status and expiry, applies the
   change, writes one `audit_log` row and stores the result. A repeated call returns the stored
   result without running again.

Rejected, expired, already used or mismatched approvals, or approvals of another user or
store, change nothing and return a clear error.

## Security model

- **Row level security.** Every table lives in the `store_ops` schema with RLS forced. Policies
  require both the current store and the user's membership in it, so a wrong setting returns
  nothing instead of another tenant's rows.
- **A limited login role.** On a real server the app logs in as a role that is only a member of
  `store_ops_app`. It has no DELETE anywhere, cannot switch to the owner, cannot bypass RLS and
  cannot change policies. `tests/pg/roles.test.ts` proves this on Postgres 17. Security definer
  functions belong to `store_ops_definer` (NOLOGIN, no BYPASSRLS) with narrow policies.
- **The store comes from auth.** No tool input contains a store id. Remote tokens carry the
  user and store chosen at consent; stdio uses a local user id from the environment.
- **Scopes per tool.** `store:read` is the baseline, `store:write` covers stock, cancellations
  and notes, and `refunds:write` is needed on top for refunds. A token without them gets a 403
  `insufficient_scope` challenge naming every scope the call needs.
- **Audit log.** `audit_log` is append-only for everyone, including the owner: a trigger blocks
  UPDATE, DELETE and TRUNCATE, and no role is granted more than INSERT and SELECT.
- **Untrusted store text.** Customer names and notes are returned as data. Tool descriptions
  and the server instructions say so, and one seeded order (#1067) carries a note written like
  an instruction to show it.
- **Remote pages.** Session and CSRF cookies are HMAC-signed `__Host-` cookies, every POST
  checks a CSRF token and the Origin, every client string is escaped, and pages send a strict
  Content Security Policy. Redirects are limited to the Claude and ChatGPT callbacks and
  loopback addresses.
- **Errors.** Only business errors reach the client. SQL and driver details go to the server
  log.

### Demo users

- "Try the demo" creates a new demo user with a freshly generated Demo Store. It lasts 24 hours.
- At expiry the store is hidden at once (RLS checks the expiry) and every tool call, token and
  sign-in session stops with a "This demo expired" message.
- An hourly Cron Trigger wipes demo stores 15 minutes or more past their expiry: everything
  except the store row and its `audit_log` rows. It runs through `store_ops.purge_expired_demo_stores`, owned by the NOLOGIN
  role `store_ops_janitor`, whose policies reach only expired demo stores. The same run revokes
  those users' OAuth grants and runs one batch of the OAuth provider's `purgeExpiredData`
  sweep. GitHub users' stores never expire.
- "Try the demo" is limited three ways, each answered with a 429 page and `Retry-After`:
  5 new demos per minute per client network (Cloudflare's Rate Limiting binding, approximate
  and per location by design), 5 per client network per UTC day, and `DEMO_DAILY_CAP` per UTC
  day in total. The daily limits are counted exactly by the database. A client network is the
  IPv4 address or the IPv6 /64, stored only as an HMAC.

## Run it locally

Requires Node 24, pnpm and (for the Worker and `pnpm test:pg`) Docker.

### stdio (Claude Desktop, Claude Code)

```sh
pnpm install
pnpm seed        # creates the local Demo Store in .data/
pnpm dev:stdio   # runs the MCP server over stdio
```

Environment variables (all optional):

- `STORE_OPS_USER_ID`: the local demo user id (a UUID). Defaults to a fixed demo id.
- `STORE_OPS_DATA_DIR`: where the local PGlite database lives. Defaults to `.data/pglite`.
- `STORE_OPS_APPROVALS_DIR`: where `pnpm run approve` leaves decisions. Defaults to
  `.data/approvals`.
- `STORE_OPS_APPROVAL_BASE_URL`: base of approval links. Defaults to `http://localhost:8787`.
- `STRIPE_SECRET_KEY`: Stripe test mode key (`sk_test_...`). Leave unset for the fake
  processor.

Approve or reject a prepared action from a second terminal while the server runs:

```sh
pnpm run approve <approval_id>
pnpm run approve <approval_id> --reject
```

### The Worker (wrangler dev)

```sh
pnpm db:up                                   # Postgres 17 in Docker on localhost:54329
pnpm test:pg                                 # once: creates the owner and login roles
docker compose exec postgres createdb -U postgres -O store_ops_owner store_ops_dev
docker compose exec postgres psql -U postgres -d store_ops_dev -c "revoke temporary on database store_ops_dev from public"
STORE_OPS_MIGRATE_URL=postgres://store_ops_owner:store_ops_owner_local@localhost:54329/store_ops_dev pnpm db:migrate
cp .dev.vars.example .dev.vars               # then set SESSION_SECRET to 32+ random characters
pnpm dev:worker                              # wrangler dev on http://localhost:8787
pnpm e2e:local                               # in a second terminal
```

`wrangler dev` reaches the compose Postgres through the Hyperdrive binding's
`localConnectionString` in `wrangler.jsonc`, logged in as `store_ops_login`. Use
`http://localhost:8787` (not `127.0.0.1`): the OAuth metadata is built for `PUBLIC_BASE_URL`.

`pnpm e2e:local` plays both the MCP client and the person in the browser: the 401 challenge,
both discovery documents, dynamic client registration, the authorization code flow with PKCE
through "Try the demo" and consent, `tools/list`, a read tool, a write tool that is refused
before approval, approved on the approval page and then executed, and one run of the
scheduled cleanup (`/cdn-cgi/local/scheduled`; `wrangler dev` does not run crons on its own).

Worker settings (`.dev.vars` locally, secrets and vars in Cloudflare):

- `PUBLIC_BASE_URL`: the public origin, no path. Also the OAuth issuer.
- `SESSION_SECRET`: 32+ characters. Signs session and CSRF cookies. A secret.
- `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`: optional. Without them only "Try the demo" shows.
- `STRIPE_SECRET_KEY`: optional, `sk_test_...` only. Leave unset for the demo.
- `DEMO_DAILY_CAP`: new demo users per UTC day (`wrangler.jsonc`, default 200).
- Bindings: `OAUTH_KV` (OAuth state), `HYPERDRIVE` (Postgres) and `DEMO_LOGIN_LIMITER` (Rate
  Limiting). Cron: `17 * * * *`.

Each `pnpm e2e:local` run creates a demo user, and all local runs come from one network, so
after 5 runs in a UTC day "Try the demo" answers 429 until midnight UTC (or recreate the
`store_ops_dev` database).

When you are done: stop `wrangler dev` and run `pnpm db:down`.

## Connect a client

### Claude Desktop (local, stdio)

In Claude Desktop's `claude_desktop_config.json`, with the absolute path to this folder:

```json
{
  "mcpServers": {
    "store-ops": {
      "command": "pnpm",
      "args": ["--dir", "/path/to/store-ops-mcp", "dev:stdio"]
    }
  }
}
```

Restart Claude Desktop. Write tools return an approval link to `http://localhost:8787`; with
only stdio running, approve with `pnpm run approve <approval_id>` instead.

### Claude Code

```sh
claude mcp add store-ops -- pnpm --dir /path/to/store-ops-mcp dev:stdio
```

Or, against the local Worker: `claude mcp add --transport http store-ops http://localhost:8787/mcp`.
Claude Code then runs the OAuth sign-in in the browser.

### Claude and ChatGPT (remote)

Add the deployed `https://<worker>/mcp` URL as a custom connector. The server supports Client ID
Metadata Documents and Dynamic Client Registration, PKCE S256, `iss` in authorization
responses, and the redirect URIs `https://claude.ai/api/mcp/auth_callback` and
`https://chatgpt.com/connector_platform_oauth_redirect`. For ChatGPT, each tool declares
`securitySchemes` (`oauth2` with the scopes it needs) and an expired demo returns
`_meta["mcp/www_authenticate"]` in the tool result, as OpenAI's Apps SDK auth guide asks.

### MCP Inspector

```sh
npx @modelcontextprotocol/inspector --cli pnpm dev:stdio -- -e STORE_OPS_DATA_DIR=.data/inspect --method tools/list
```

The `-e` flag goes after `--`: the Inspector does not pass your shell environment to the server.
Against the Worker, `npx @modelcontextprotocol/inspector --cli http://localhost:8787/mcp
--method tools/list` shows the OAuth challenge; the interactive sign-in needs a terminal (or
use the Inspector's web UI). More in `.claude/skills/inspect/SKILL.md`.

## Testing

- `pnpm test`: the fast suite, no Docker. Everything runs in Node on in-memory PGlite,
  including the Worker app with small stand-ins for the Workers runtime (`tests/support/`): an
  in-memory KV, a fake rate limiter, the `cloudflare:workers` module and the
  `global_fetch_strictly_public` flag. Tests never call GitHub or Stripe.
- `pnpm test:pg`: the database suites again on real Postgres 17 (`pnpm db:up` first), logged
  in as a role that is only a member of `store_ops_app`, plus `tests/pg/`: the login role cannot
  escape RLS, the definer and janitor roles hold only what they need, and locks hold under
  parallel connections.
- `pnpm e2e:local`: the full remote flow against `wrangler dev` (see above).
- `pnpm typecheck` and `pnpm lint` (zero warnings).
- CI (`.github/workflows/ci.yml`) runs typecheck, lint, `pnpm test` and `pnpm test:pg` with a
  Postgres 17 service container.

### Migrations on a real server

`pnpm db:migrate` applies `migrations/` with `STORE_OPS_MIGRATE_URL`, which must connect as the
schema owner (never the app's login role). The app's login role is created once by hand and
only granted `store_ops_app`:

```sql
create role store_ops_login login password '...';
grant store_ops_app to store_ops_login;
revoke temporary on database <db> from public;
```

## Verified on the live server

- **Neon.** Migrations 0001 to 0007 applied as the owner. The app connects as
  `store_ops_login` (no superuser, no BYPASSRLS, only a member of `store_ops_app`); on Neon it
  was refused when trying to switch to the owner or definer role, disable RLS, delete from
  `audit_log`, or create tables.
- **Hyperdrive and the Worker.** `pnpm e2e:local https://store-ops-mcp.mostafawork5517.workers.dev`
  passes every step: the 401 challenge, both discovery documents, dynamic client registration,
  demo sign-in, consent, the PKCE token exchange, `tools/list`, a read tool, and a write tool that
  is refused until it is approved on the approval page and then runs once.
- **CI.** GitHub Actions runs typecheck, lint, the PGlite suite and the Postgres 17 suite on
  every push.

## Not verified yet

- **Real Claude and ChatGPT connections.** The OAuth and ChatGPT requirements were implemented
  from the specs and docs and tested with a scripted client, not yet from the Claude or ChatGPT
  apps.
- **The scheduled cleanup on Cloudflare.** It is deployed (`17 * * * *`) and was tested in
  `wrangler dev`; its first production run has not been checked yet.
- **The rate limit in production.** It worked in `wrangler dev` (local simulation: the 6th
  request in a minute got 429); Cloudflare documents it as approximate and per location.
- **Cron limits.** One run does one OAuth sweep batch of 50, wipes up to 10 stores and revokes
  up to 25 grants. Whether that stays within the Workers subrequest and KV limits of the chosen
  plan is not measured.
- **Parallel sign-ups.** The daily caps are counted under an advisory lock, but there is no
  parallel-connection test for them yet (as there is for store provisioning).
- GitHub sign-in was tested against a fake GitHub only.

## License

Not licensed for reuse. This repository is a portfolio demo.
