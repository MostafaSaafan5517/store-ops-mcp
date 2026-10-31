---
name: new-tool
description: Add a new MCP tool to Store Ops MCP following the repo conventions (strict zod input without a store id, output schema, annotations, RLS-scoped access, safe errors), and for write tools the approval flow through runWrite.
argument-hint: <tool_name> <read|write> <what it does>
disable-model-invocation: true
---

# New tool

Add this tool: $ARGUMENTS

Read `src/tools/shared.ts`, and for a write tool `src/tools/approval-flow.ts`, before writing
code. Copy the closest existing tool: `src/tools/products.ts` for reads,
`src/tools/stock-writes.ts` for writes.

## Rules for every tool

- Put it in the right `src/tools/<group>.ts` file (or a new group file registered in
  `createStoreOpsServer` in `src/server.ts`).
- `inputSchema` is a `z.strictObject`. It never contains a store id at any depth: the store
  comes from `context.principal`. Every field has `.describe(...)` and sensible bounds.
- `outputSchema` is a `z.object` that matches exactly what the tool returns.
- Results go through `jsonResult` (`structuredContent` plus the same JSON as text). Business
  errors (not found, not allowed in this state) throw `ToolError` with a clear message, which
  becomes `isError: true`. Unexpected errors are left to the runner, which sends them to
  `onError` and returns a generic message.
- All data access runs inside the runner (`runRead` or `runWrite`), which uses
  `withPrincipal`. Never query outside it. SQL values go in as `$n` parameters; search text
  goes through `likePattern`.
- Money is integer cents: `*_cents` fields with `centsSchema`.
- Lists paginate with `limitSchema(default)` (capped at 50), `cursorSchema`,
  `nextCursorSchema`, `encodeCursor`, `decodeCursor` and `paginate` (query `limit + 1` rows).
- If the tool returns customer names, emails or notes, add `UNTRUSTED_NOTE` to its
  description.
- Description: one or two plain sentences on what it does and when to use it. No em dashes.

## Read tools

- `annotations: READ_ONLY`.
- Handler: `(input) => runRead(context, async (tx) => { ... })`.

## Write tools

- Add the tool name to `WriteToolName` in `src/approvals.ts` and add a new migration that
  extends the `approvals_tool_check` constraint (use the `new-migration` skill; never edit
  `0003_approvals_and_audit.sql`).
- Define a `WriteToolSpec<Args, Result>`:
  - `plan(tx, args)`: validates against current data and returns `{ summary, effect }`.
    It must not write anything. `summary` states the exact effect in plain words.
  - `execute(tx, { args, effect, approvalId, now })`: parses `effect` with a zod schema,
    re-checks it against current data (never trust the plan), applies it and returns
    `{ result, summary }`.
- Register with:
  - `inputSchema: args.extend({ approval_id: approvalIdSchema })`
  - `outputSchema: writeOutputSchema(resultSchema)`
  - `annotations: writeAnnotations({ destructive: <true if it removes or reverses> })`
  - description ending with `APPROVAL_FLOW_NOTE`; use `reasonSchema` for a reason field
  - handler `(input, ctx) => runWrite(context, spec, input, ctx)`
- `runWrite` handles everything else: the pending approval, form elicitation or the approval
  link, the locked single-use execution, the audit row and the replay. Do not reimplement any
  of it, and never call `execute` directly.
- Payments go through `context.payments` only, with the approval id as the idempotency key.

## Tests

- Add the name to `READ_TOOLS` or `WRITE_TOOLS` in `tests/tool-schemas.test.ts`.
- Reads: cases in `tests/read-tools.test.ts` (happy path, not found, pagination if any).
- Writes: cases in `tests/write-tools.test.ts`: the first call changes nothing, execution
  after approval, invalid input, and the re-check at execution time.
- Run `pnpm typecheck`, `pnpm lint` and `pnpm test`. All must pass.
- Suggest running the `store-ops-security-reviewer` subagent before committing.
