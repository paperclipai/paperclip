# Plan: Push a plan from Claude Code into MyHive

## Context

The operator wants to author a plan **from Claude Code** (this CLI / any Claude Code session)
and have the MyHive board pick it up automatically — no manual UI authoring, no chat drawer
(the earlier chat-drawer idea is dropped). They want it reachable two ways: an MCP tool (native
to Claude Code) and a CLI command (`paperclipai`).

**Key finding — no server/UI change is needed for board pickup.** Creating a plan via
`POST /api/plans`:
- auto-sets `workMode='planning'` + `status='backlog'` (`server/src/services/plans.ts:46-56`),
  so the board's `columnForIssue` routes it to the **Plans** column
  (`ui/src/lib/hive-board.ts:48-50`);
- calls `logActivity(action:"plan.created", entityType:"issue")`
  (`server/src/routes/plans.ts:65-75`), which `publishLiveEvent({type:"activity.logged"})`
  (`server/src/services/activity-log.ts:85-98`). `LiveUpdatesProvider` handles `activity.logged`,
  and on `entityType==="issue"` invalidates `queryKeys.issues.list(companyId)`
  (`ui/src/context/LiveUpdatesProvider.tsx:664-665`). The board query key
  `["issues", companyId, "hive-board"]` is prefix-matched by that, so an **open board refetches
  live** the instant a plan is pushed.

So the entire feature = two thin ingress clients that POST `/api/plans`. Plans land as **drafts**;
the operator clicks **Activate** on the board to start work (matches existing semantics).

## Contract being targeted (already built, unchanged)

`POST /api/plans` — `server/src/routes/plans.ts:44`, zod schema lines 20-28. Body:
- `companyId` (required, uuid)
- `title` (required, min 1)
- `overview` (optional string|null)
- `tiers` (optional array): `{ id, kind:"phase"|"wave", name, requestedChildren:[{title, description?, priority?, assigneeAgentId?}], childIssueIds:[] }`
- `budgetCapTokens` / `budgetCapCents` (optional, non-negative int|null)
- `assigneeAgentId` (optional uuid|null)

Auth: `assertCompanyAccess(req, body.companyId)` — bearer token (agent JWT or user). Attribution
auto from actor. No activation here; appears as draft in Plans column.

## Shared payload shaping (both ingresses, identical logic)

Inputs the operator gives Claude Code: `title`, optional `overview`, a list of `tasks`
(tier-1 task titles), optional `tokenCap`, optional `assigneeAgentId`. Build:

```
tiers = tasks.length
  ? [{ id: "tier-1", kind: "phase", name: "Phase 1",
       requestedChildren: tasks.map(t =>
         typeof t === "string" ? { title: t } : t),   // allow {title,description?,priority?,assigneeAgentId?}
       childIssueIds: [] }]
  : undefined                                          // empty draft is valid; activate needs tasks (E9 guard)
body = { companyId, title, overview, tiers, budgetCapTokens: tokenCap, assigneeAgentId }
```

Note the E9 guard: activate requires the first tier to have `requestedChildren`
(`services/plans.ts:120-124`). Pushing with no tasks is allowed but the operator must add tasks
on the board before Activate works — surface that in tool/command help text.

## Part A — MCP tool

**File:** `packages/mcp-server/src/tools.ts` — add one entry to `createToolDefinitions()`,
next to `paperclipCreateIssue` (~line 456). Follow the exact `makeTool(...)` + `client.requestJson`
pattern already used there.

```ts
makeTool(
  "paperclipCreatePlan",
  "Create a MyHive plan (draft) that appears in the board's Plans column. Provide a task list (tier-1 titles); the operator clicks Activate on the board to start work. Does NOT run agents.",
  z.object({
    companyId: companyIdOptional,
    title: z.string().min(1).max(240),
    overview: z.string().optional(),
    tasks: z.array(
      z.union([
        z.string().min(1),
        z.object({
          title: z.string().min(1),
          description: z.string().optional(),
          priority: z.enum(["low","medium","high"]).optional(),
          assigneeAgentId: z.string().uuid().optional(),
        }),
      ]),
    ).default([]),
    tokenCap: z.number().int().nonnegative().optional(),
    assigneeAgentId: z.string().uuid().optional(),
  }),
  async ({ companyId, title, overview, tasks, tokenCap, assigneeAgentId }) => {
    const tiers = tasks.length
      ? [{ id: "tier-1", kind: "phase", name: "Phase 1",
           requestedChildren: tasks.map(t => (typeof t === "string" ? { title: t } : t)),
           childIssueIds: [] }]
      : undefined;
    return client.requestJson("POST", "/plans", {
      body: {
        companyId: client.resolveCompanyId(companyId),
        title, overview, tiers,
        budgetCapTokens: tokenCap ?? null,
        assigneeAgentId: assigneeAgentId ?? null,
      },
    });
  },
),
```

`companyId` defaults from `PAPERCLIP_COMPANY_ID` via `client.resolveCompanyId`
(`packages/mcp-server/src/client.ts:62-66`). Path `/plans` resolves against the `/api`-suffixed
base. `companyIdOptional` and `makeTool` already exist in the file — reuse, no new imports beyond
what's there (`z` is imported).

**Test:** `packages/mcp-server/src/__tests__/` — mirror an existing create-tool test; assert it
POSTs `/plans` with the shaped `tiers` and resolved `companyId`. Build the package
(`pnpm --filter @paperclipai/mcp-server build`).

## Part B — CLI command

**New file:** `cli/src/commands/client/plan.ts` — `export function registerPlanCommands(program)`,
following `cli/src/commands/client/issue.ts:259-313` (uses `addCommonClientOptions`,
`resolveCommandContext`, `apiPath`, `printOutput`, `handleCommandError`).

```
paperclipai plan create \
  -C <companyId> \
  --title "<title>" \
  [--overview "<text>"] \
  [--task "<title>" ...]        // repeatable; commander: .option("--task <t>", ..., collect, [])
  [--token-cap <n>] \
  [--assignee-agent-id <id>]
```

Handler builds the same shared payload, then
`ctx.api.post(apiPath`/api/plans`, body)` (top-level route; companyId in body, not the URL —
unlike `issue create` which uses `/api/companies/:id/issues`). Print the created plan JSON.

**Register:** `cli/src/index.ts` — import `registerPlanCommands` (~line 40) and call it alongside
the other `registerXxxCommands(program)` calls (~line 180).

**Test:** `cli/src/**/__tests__` — add a unit test mirroring an existing client-command test
(stub the api client, assert POST `/api/plans` body shape). Build (`pnpm --filter paperclipai build`
or the workspace's CLI build script).

## Files

| File | Change |
|---|---|
| `packages/mcp-server/src/tools.ts` | + `paperclipCreatePlan` tool in `createToolDefinitions()` |
| `packages/mcp-server/src/__tests__/*` | + test for the new tool |
| `cli/src/commands/client/plan.ts` | **new** — `registerPlanCommands` with `plan create` |
| `cli/src/index.ts` | import + register `registerPlanCommands(program)` |
| `cli/src/**/__tests__/*` | + test for `plan create` |

No changes to server, db, shared, or ui. The board, live-update wiring, and `POST /plans`
already support this end to end.

## Verification (end to end)

1. Build both packages (commands above). Run the server + UI (`pnpm dev`), open `/board`.
2. Ensure env for the clients: `PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY` (and
   `PAPERCLIP_COMPANY_ID` for MCP) — or `~/.paperclip/auth.json` + `-C` for CLI.
3. **MCP:** add `@paperclipai/mcp-server` to Claude Code's MCP config; in a Claude Code session,
   invoke `paperclipCreatePlan` with a title + 2-3 tasks. Confirm a draft plan card appears in the
   board **Plans** column **without reloading** (live `activity.logged` refetch).
4. **CLI:** `paperclipai plan create -C <id> --title "Smoke test" --task "A" --task "B"`.
   Confirm 201 JSON returned and the card appears live on the board.
5. On the board, open the plan → tasks listed → click **Activate** → tier-1 tasks materialize in
   **Open** and assigned agents (if any) wake. (Existing path; just confirming the pushed plan is a
   normal, activatable plan.)
6. Negative: push with no `--task`/empty `tasks` → plan appears as empty draft; Activate is blocked
   until tasks are added (E9 guard) — confirm the help text says so.
