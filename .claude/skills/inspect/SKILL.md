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
would lock the default `.data/pglite`. Point the smoke test at its own folder, which is git
ignored:

- Git Bash: `export STORE_OPS_DATA_DIR=.data/inspect STORE_OPS_APPROVALS_DIR=.data/inspect-approvals`
- PowerShell: `$env:STORE_OPS_DATA_DIR='.data/inspect'; $env:STORE_OPS_APPROVALS_DIR='.data/inspect-approvals'`

Leave `STRIPE_SECRET_KEY` unset so refunds use the fake processor.

## 3. Run the checks

NOT VERIFIED: these exact command lines have not been run in this repo yet. The flag syntax is
from the README above; whether the Inspector can spawn `pnpm` on Windows, and which protocol
version it negotiates with our server (2026-07-28 or the 2025 legacy handshake), are unchecked.
Note what happened the first time you run them and update this section.

1. List tools. Expect the 6 read tools and 4 write tools from `tests/tool-schemas.test.ts`:

   ```bash
   npx @modelcontextprotocol/inspector --cli pnpm dev:stdio -- --method tools/list
   ```

2. Call a read tool (default `get_stock_levels`, or the tool in $ARGUMENTS). Expect
   `structuredContent` and no `isError`:

   ```bash
   npx @modelcontextprotocol/inspector --cli pnpm dev:stdio -- --method tools/call --tool-name get_stock_levels
   ```

3. Start a write tool. Expect `status: "approval_required"`, an `approval_id`, an
   `approval_url` and an `approve_command`, and no change in stock:

   ```bash
   npx @modelcontextprotocol/inspector --cli pnpm dev:stdio -- --method tools/call --tool-name adjust_stock --tool-arg sku=KIT-004 --tool-arg quantity_change=1 --tool-arg reason=smoke-test
   ```

   If the server rejects `quantity_change` as a string, the Inspector did not parse the value
   as JSON; check the README for how it types `--tool-arg` values. Do not approve it. The point is that nothing executes without a human decision.

If spawning `pnpm` fails on Windows, use the same commands with
`node node_modules/tsx/dist/cli.mjs src/stdio.ts` in place of `pnpm dev:stdio`.

## 4. Report

For each step: the command, pass or fail, and the relevant part of the output. Server logs go
to stderr and start with `[Store Ops MCP]`. Delete `.data/inspect` and
`.data/inspect-approvals` afterwards if you want a fresh store next time.

## Later (Run 3)

The same checks against the local Worker over Streamable HTTP. Look up the Inspector's HTTP
target syntax with context7 at that point.
