---
name: inspect
description: Smoke test the Store Ops MCP stdio server with the MCP Inspector CLI (list tools, call a read tool, start a write tool that must stop at approval_required). Use after changing tools or the stdio entry, before saying a tool change works in a real MCP client.
argument-hint: [tool_name to call, default get_stock_levels]
---

# MCP Inspector smoke test (stdio)

Runs the official MCP Inspector in CLI mode against `pnpm dev:stdio`. The Inspector is fetched
by `npx`; nothing is installed globally. Run every command from the repo root.

## 1. Check the CLI flags first

The Inspector changes often. Before running anything, confirm the current flags with context7
(library `/modelcontextprotocol/inspector`, file `clients/cli/README.md`) or with
`npm view @modelcontextprotocol/inspector version`.

Checked on 2026-10-31 against version 2.13.0 (context7, official README): CLI mode is
`--cli <server command> --method <method>`, tools are called with
`--tool-name <name> --tool-arg key=value`, and when the line starts with the server command,
a bare `--` ends the server command and starts the Inspector options. If the flags differ now,
update this file before continuing.

## 2. Use a throwaway database

PGlite allows one connection, so a running `pnpm dev:stdio` (for example in Claude Desktop)
would lock the default `.data/pglite`. Point the smoke test at its own git-ignored folder with
the Inspector's `-e` flag. The Inspector does not pass your shell environment to the server
(checked 2026-11-01: an exported `STORE_OPS_DATA_DIR` was ignored and the server opened
`.data/pglite`), and `-e` works only after the bare `--` (before it, the Inspector reported
"Method is required").

Leave `STRIPE_SECRET_KEY` unset so refunds use the fake processor.

## 3. Run the checks

Verified on 2026-11-01 with Inspector 2.13.0 on Windows (Git Bash), spawning `pnpm` directly:

1. List tools. Expect the 6 read tools and 4 write tools from `tests/tool-schemas.test.ts`:

   ```bash
   npx @modelcontextprotocol/inspector --cli pnpm dev:stdio -- -e STORE_OPS_DATA_DIR=.data/inspect -e STORE_OPS_APPROVALS_DIR=.data/inspect-approvals --method tools/list
   ```

2. Call a read tool (default `get_stock_levels`, or the tool in $ARGUMENTS). Expect
   `structuredContent` and no `isError`:

   ```bash
   npx @modelcontextprotocol/inspector --cli pnpm dev:stdio -- -e STORE_OPS_DATA_DIR=.data/inspect -e STORE_OPS_APPROVALS_DIR=.data/inspect-approvals --method tools/call --tool-name get_stock_levels
   ```

3. Start a write tool. Expect `status: "approval_required"`, an `approval_id`, an
   `approval_url` and an `approve_command`, and no change in stock (`--tool-arg` values are
   parsed as JSON, so `quantity_change=1` arrives as a number):

   ```bash
   npx @modelcontextprotocol/inspector --cli pnpm dev:stdio -- -e STORE_OPS_DATA_DIR=.data/inspect -e STORE_OPS_APPROVALS_DIR=.data/inspect-approvals --method tools/call --tool-name adjust_stock --tool-arg sku=BAG-001 --tool-arg quantity_change=1 --tool-arg reason=smoke-test
   ```

   Do not approve it. The point is that nothing executes without a human decision.

The CLI also prints a "Schema portability" summary (7 warnings across 7 tools on
2026-11-01). Re-run with `--strict` for details; they are advisory.

## HTTP (the local Worker)

With `pnpm dev:worker` running, `npx @modelcontextprotocol/inspector --cli
http://localhost:8787/mcp --method tools/list` gets the 401 challenge and then stops with
`auth_required` ("Interactive OAuth requires a TTY"), which is the expected behaviour without
a token. The full OAuth flow and tool calls over HTTP are covered by `pnpm e2e:local`.

## 4. Report

For each step: the command, pass or fail, and the relevant part of the output. Server logs go
to stderr and start with `[Store Ops MCP]`. Delete `.data/inspect` and
`.data/inspect-approvals` afterwards if you want a fresh store next time.
