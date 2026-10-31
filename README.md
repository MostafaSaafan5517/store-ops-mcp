# Store Ops MCP

An MCP server for a small online store: orders, products, stock and refunds, usable from
Claude, ChatGPT and other MCP clients.

**This is a demo.** It only ever works with generated demo data labelled "Demo Store".
All customers, products and orders are fake, and customer emails use `example.com`.

Status: work in progress. Read tools and a local stdio server are available; write tools with
human approval, remote HTTP with OAuth, and full setup docs are coming.

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
