# Store Ops MCP

An MCP server for a small online store: orders, products, stock and refunds, usable from
Claude, ChatGPT and other MCP clients.

**This is a demo.** It only ever works with generated demo data labelled "Demo Store".
All customers, products and orders are fake, and customer emails use `example.com`.

Status: work in progress. Read tools, write tools with human approval and a local stdio server
are available; remote HTTP with OAuth, the approval web page and full setup docs are coming.

## Write tools need a human

`adjust_stock`, `cancel_order`, `issue_refund` and `add_order_note` never change anything on
the first call. They return a plain summary of the exact effect and an `approval_id`. A person
approves it (in chat when the client supports it, or locally with `pnpm approve <id>`), and
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
- `STORE_OPS_APPROVALS_DIR`: where `pnpm approve` leaves decisions. Defaults to `.data/approvals`.
- `STORE_OPS_APPROVAL_BASE_URL`: base of approval links. Defaults to `http://localhost:8787`.
- `STRIPE_SECRET_KEY`: Stripe test mode key (`sk_test_...`). Leave unset for the fake processor.

Approve or reject a prepared action from a second terminal while the server runs:

```sh
pnpm approve <approval_id>
pnpm approve <approval_id> --reject
```
