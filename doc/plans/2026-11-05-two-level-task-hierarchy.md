# Two-level task hierarchy for agent-created work

Date: 2026-11-05
Status: Implemented with the recommended answers to the open decisions; see the
implementation notes below for where the code differs from this plan.

## Implementation notes

- **Exempt system machinery.** Watchdog review issues and their serialized
  follow-ups, monitor recovery, email-channel boundary placement, and
  human-configured routines pass `allow_nested`. These subsystems locate their
  work by `parentId`, or place it inside a trust boundary, so flattening them
  would break them. They are not agent-authored decomposition. Agent-authored
  routines (`createdByAgentId`) still flatten.
- **Low-trust guard.** Placement never moves a task above a low-trust boundary
  root (`executionPolicy.authorizationPolicy.trustBoundary.rootIssueId`) that
  contains the requester. In that case the requested parent is kept.
- **Origin tracking reuses `createdFrom`.** The existing "Created from" detail
  field and the `createdFromIssueId` list filter now read `origin_issue_id`
  first and fall back to the run-derived source. `createdFrom.run` is nullable.
  `origin_run_id` was already harness-only: the create schema does not accept
  it.
- **Runner and project tool contracts are unchanged.** `create_task`'s input and
  output schemas are strict pack contracts, so this change adds no
  `parentTaskId` input or `parentAdjusted` output to them. The tool result
  already reports the effective `parentId`, and the activity log records
  `parentAdjusted`. Chat agents build parent + child trees through the issues
  API (`parentId` set to a task they created) or nested `suggest_tasks`.
  Extending the tool contract is a follow-up.
- **Chat parent scope (Open decision 5).** Not restricted to tasks from the
  same conversation. Chat agents may parent under any task they may write, the
  same as other agents, and the depth limit still applies.

## Goal

Agents (and the automation acting for them) may only build **parent → child**
trees. When an agent asks for a grandchild, the request **does not error**: the
new task becomes a **sibling** of the requesting child (parented to the root of
the tree), and the response says so.

Humans are not restricted. A board user can create or move tasks to any depth
from the UI, CLI or API.

Separately, every task records **where it came from**, both the originating task
and the originating run. That record is an audit trail, not hierarchy, and only
the harness sets it.

Kept exactly as-is:

- **Existing data.** Legacy grandchildren and deeper trees stay valid. There is
  no backfill, and every read path (tree views, subtree pause/cancel, recovery,
  watchdog subtree scans, privacy propagation, cost rollups) keeps walking
  arbitrary depth.
- **Hierarchy data model.** `issues.parent_id` stays a plain self-FK with no
  depth constraint, so deeper nesting can come back for agents by changing one
  constant. The only schema change is the additive `origin_issue_id` column.
- **Goals and folders** (they are not tasks), and **`requestDepth`** (the
  delegation counter).

## 1. Who the rule applies to

The depth rule is an **actor policy**, not a data rule.

| Creator | Policy |
|---|---|
| Board user (UI, CLI with user auth, API with board session) | `allow_nested`. No change from today |
| Agent via HTTP API, CLI with agent key, runner `create_task`, project tools `create_task` | `flatten` |
| Agent-authored chat suggestions (`suggest_tasks`), even when a user clicks accept | `flatten`, because the agent authored the shape. See Open decision 2 |
| Harness/system creators: native delegation, accepted-plan decomposition, decisions effects, recovery, watchdog, routines | `flatten` |
| Plugins (`issues.create`) | `flatten` (automation). See Open decision 3 |
| `importIssues` / company import | exempt; preserves trees verbatim |

Implementation: add `parentDepthPolicy?: "flatten" | "allow_nested"` to the
`create` / `createChild` / `update` inputs in `server/src/services/issues.ts`.
The **default is `flatten`**, so any internal caller is safe by default. Only
the board-actor branches of the routes pass `allow_nested`
(`req.actor.type === "board"`).

## 2. The flatten rule

Add to `packages/shared`:

```ts
export const MAX_AGENT_TASK_HIERARCHY_DEPTH = 2; // root + one level of children
```

Add one resolver next to `assertExecutionTaskParent`
(`server/src/services/issues.ts:2047`):

```ts
resolveNewTaskParent(db, companyId, requestedParentId, policy)
  -> { effectiveParentId, requestedParentId, flattened: boolean }
```

- `allow_nested` or requested parent is top-level → unchanged.
- Requested parent has a parent → use the **root** of that tree. In a 2-level
  tree that is exactly "sibling of the requester". For a legacy deep tree it
  still yields a 2-level edge.
- `assertExecutionTaskParent` (conversations cannot be parents) still runs on
  the effective parent. If the root is a conversation (only possible with legacy
  data), fall back to top-level instead of erroring.

**Never an error for agents.** Flattening is silent at the data level and
visible in the response:

```jsonc
// create / createChild / update response
"parentAdjusted": {
  "reason": "max_agent_depth",
  "requestedParent": { "id": "…", "identifier": "ENG-34" },
  "effectiveParent": { "id": "…", "identifier": "ENG-12" }
}
```

The same object goes into the `issue.created` / `issue.child_created` /
`issue.updated` activity-log details. Runner and project-tool results surface it
in the tool result text ("Created ENG-40 under ENG-12 as a sibling of ENG-34;
agents can nest only one level"), so the model learns in-loop.

**What the requester keeps when flattened:**

1. **Waiting.** `blockParentUntilDone: true` adds a `blocks` relation *new task →
   requester* instead of blocking the root. Blocker resolution
   (`issue-dependency-wakeups.ts`) wakes the requester.
2. **Workspace.** `inheritExecutionWorkspaceFromIssueId` = the requester, so the
   sibling runs where the grandchild would have.
3. **Privacy.** `privacyParentIssueId` = the requester, not the root
   (`issues.ts:~10621`). Otherwise a task spawned from a private child could end
   up more visible than its creator.
4. **Origin.** `originIssueId` = the requester (§3).

**Re-parenting by an agent** (`PATCH parentId`):

- The target is a child → flatten to its root with a `parentAdjusted` notice.
- The moved issue itself has children (moving it under anything would make
  grandchildren) → **do not error**. Skip only the parent change, apply the rest
  of the patch, and return `parentAdjusted: { reason: "has_children", applied:
  false }`. See Open decision 1.

## 3. Originating task and originating run

Both are nullable. **Only the harness sets them.** They are never agent tool
parameters or request-body fields, and they never change after create.

### `origin_issue_id` (new column)

`issues.origin_issue_id uuid references issues(id) on delete set null`, indexed
on `(company_id, origin_issue_id)`. It is never read for hierarchy,
authorization or wakes.

The harness derives it in this order:

1. the **requested** parent, before flattening (so for unflattened children it
   equals `parentId`; that duplication is fine and keeps queries simple)
2. otherwise the run-bound task of the creating agent run, **including a
   conversation**, so chat-created tasks record their chat
3. otherwise the source task of system creators: recovery and watchdog source,
   decision target, native delegation source, plan-decomposition source, routine
   `parentIssueId`, chat-suggestion interaction issue
4. otherwise null (plain board/UI creates)

### `origin_run_id` (existing column, tighten it)

`issues.origin_run_id` already exists (`packages/db/src/schema/issues.ts:67`),
and the create route already defaults it to `actor.runId`
(`routes/issues.ts:12838`). To make it harness-only and reliable:

- Stop honouring a client-supplied `originRunId` on create
  (`routes/issues.ts:12757-12838` reads `createBody.originRunId`). Derive it only
  from the authenticated actor's run, or from the internal caller. Confirm the
  shared `createIssueSchema` does not accept it, and keep it out of the CLI,
  plugin SDK and tool schemas.
- Set it in every harness path that has a run: runner tools (already
  `binding.runId`), project tools, native delegation, accepted-plan
  decomposition, chat suggestions (`interaction.sourceRunId`), recovery and
  watchdog creators where a run triggered them.
- **Overload to resolve:** for `originKind = "routine_execution"` the column
  holds a **routine-run** id (`routines.ts:1925`), not a heartbeat run, and
  `task-creation-provenance.ts` depends on that. Options are in Open decision 4.

### Contracts and surfacing

- `packages/db` schema plus a `pnpm db:generate` migration (additive nullable
  column + index).
- `packages/shared` `Issue` type (read-only fields `originIssueId`, plus
  `originIssue: { id, identifier, title } | null` on detail reads); not present
  in any create/update validator.
- Server: set both fields in `create()` / `createChild()`; include them in
  serializers and the activity log. `task-creation-provenance.ts` follows
  `originIssueId` as an edge, so routine/shareability provenance survives
  flattening.
- UI: "Created from ENG-34 · run abc123" in issue properties, linking to the
  task and the run.
- `importIssues`: carry the fields only if the bundle has them, else null.

## 4. Chat with an agent

Chat agents may create **one top-level task, a top-level task with subtasks, or
several independent top-level tasks**, whichever fits. The code allows all
three, and the prompts guide the choice. The agent depth rule still applies, so
nesting beyond one level is flattened.

What exists today, and what changes:

- **The conversation itself never becomes a parent.** Keep this
  (`assertExecutionTaskParent`). Chat-created work hangs off its *own* top-level
  task, not the chat. `originIssueId` = the conversation records the link.
- **Runner `create_task` in a conversation** always creates top-level and has no
  parent input (`paperclip-runner-tool-authority.ts:1706/1803`). To allow
  "top-level task + subtasks" in one chat, let the conversation-bound tool accept
  an optional parent **that is a task created from this same conversation**
  (`originIssueId` = this conversation). Anything else is ignored (created
  top-level, with a notice). This keeps chat agents from attaching work to
  arbitrary existing tasks while still allowing their own small trees. See Open
  decision 5.
- **Project tools `create_task`** (`project-tools.ts:50`) hard-codes
  `parentId: null` for conversations. Same change as the runner tool.
- **HTTP API from a chat run** (`POST /companies/:id/issues`): explicit
  `parentId` is already allowed and goes through flatten. No change beyond §2.
- **Chat suggestions (`suggest_tasks`)** already support `parentClientKey`
  nesting and default to top-level for conversations
  (`issue-thread-interactions.ts:~4325`). This stays open to both shapes. Nesting
  deeper than one level is flattened on accept (agent-authored → `flatten`).
- **Prompts.** `server/src/services/agent-conversations.ts:108` currently says
  "Create ordinary assigned tasks, never subtasks of this conversation … omit
  parentId", and `:119` says "Omit parentId: the accepted task is standalone".
  Rewrite both to:
  - never use the conversation as a parent;
  - for one coherent outcome, create one top-level task;
  - for a large outcome with parts one owner coordinates, create a top-level
    task and child tasks under it;
  - for unrelated outcomes, create separate top-level tasks;
  - only one level of children; deeper requests become siblings;
  - use `blockedByIssueIds` for ordering, not nesting.

## 5. Choke points

Enforcement lives in `server/src/services/issues.ts`, with routes resolving
**before** authorization so permission checks run against the parent actually
written:

| Method | Line | Change |
|---|---|---|
| `create()` | ~10247 | resolve parent per policy; set `originIssueId` / `originRunId`; apply "requester keeps" rules |
| `createChild()` | ~9644 | resolve parent before idempotency/child-count/inheritance; inheritance and `blockParentUntilDone` stay pointed at the requester |
| `update()` | ~11169 | agent policy: flatten target, or skip the move if the issue has children |
| `importIssues()` | ~10911 | exempt (comment why) |

Routes (`server/src/routes/issues.ts`):

- `POST /companies/:id/issues` (~12630-12860). Board → `allow_nested`. Agent →
  resolve the effective parent first, including the **run-delegation default**
  (`resolveRunDelegationParentDefault`, :3830), which is the main source of
  agent grandchildren today. Run `assertIssueWriteInfluenceAllowed` /
  `assertTaskBridgeCreateAllowed` / `assertTaskWatchdogCreateIssueAllowed`
  against the effective parent, and keep the read check on the requested parent.
  For the implicit default, any denial falls back to standalone, as today.
- `POST /issues/:id/children` (~13086-13300). Same treatment.
- `PATCH /issues/:id`. Same treatment.

## 6. Every agent/harness creator (covered by the choke points; one test each)

- Runner `create_task`: `paperclip-runner-tool-authority.ts:1803` always calls
  `createChild(binding.issueId)`. Update its description in
  `packages/paperclip-runner/src/protocol-actions/create-task.ts`.
- Project tools `create_task`: `project-tools.ts:50`.
- Native `create_delegated_issue`: `status-decision-committer.ts:729`.
- Accepted-plan decomposition: `issues.ts:~10021`. Its cursor tracks explicit
  child IDs, not `parentId`, so it is unaffected.
- Decisions `create_issue`: `decisions.ts:466/530`.
- Routines: `routines.ts:1913` (`routine.parentIssueId`).
- Chat suggestions: `issue-thread-interactions.ts:~4325-4372`, plus the scope
  resolver at `routes/issues.ts:~6200`.
- Muse `task.create`: `modules/external-agents/muse.ts:547-561`. Dot:
  `modules/external-agents/dot.ts:353` (verify).
- Plugin SDK: `plugin-host-services.ts:2134/3161`.
- Recovery: `heartbeat/scheduling.ts:329` (its lookup keys on `originId`, so it
  is safe). Watchdog: `task-watchdogs.ts:1445`. Audit `services/recovery/*` for
  lookups keyed on `parentId` before flattening.

## 7. UI, CLI, docs

- **UI.** No new restrictions. "Add subtask", the parent picker and
  `NewIssueDialog` keep allowing any depth for users. Add: "Created from …"
  provenance, and a toast/inline note when an agent-facing response carries
  `parentAdjusted` (for example in task-chat created-task cards,
  `ui/src/components/task-chat/task-created-items.ts`).
- **CLI** (`cli/src/commands/client/issue.ts:289-352`). With an agent key, print
  the `parentAdjusted` notice. With user auth, nesting is unrestricted.
- **Skills/docs.** Update `skills/paperclip/SKILL.md`,
  `skills/paperclip/references/api-reference.md`,
  `skills/paperclip-board/SKILL.md` and
  `packages/skills-catalog/catalog/bundled/paperclip-operations/issue-triage/SKILL.md`:
  agents nest one level, deeper requests become siblings, use
  `blockedByIssueIds` for ordering. Do the same for the external
  `paperclip-converting-plans-to-tasks` skill. Add the rule to
  `doc/SPEC-implementation.md` (additive).

## 8. Tests

1. Agent create under a child → sibling, with `parentAdjusted` in the response
   and the activity log, and `originIssueId` = the requester.
2. Board create under a child → real grandchild, no notice.
3. Agent `createChild` on a child with `blockParentUntilDone` → blocks and later
   wakes the requester; the workspace is inherited from the requester; privacy
   follows the requester.
4. Run-delegation default from a run on a child → sibling. A protected root
   falls back to standalone (implicit) or 403 (explicit).
5. Runner `create_task` from a child binding → sibling, with the notice in the
   tool result.
6. Agent PATCH onto a child → flattened; agent PATCH of an issue with children →
   parent change skipped with a notice and the rest of the patch applied; board
   PATCH → unrestricted.
7. Chat: runner/project-tool creates top-level with `originIssueId` = the
   conversation; a child of a task created in the same chat is allowed; a parent
   outside the chat → top-level with a notice; the conversation as parent →
   top-level.
8. `originRunId` from the request body is ignored, and the harness value wins.
9. Legacy deep trees: reads, subtree pause/cancel and privacy are unchanged; an
   agent create under a depth-3 node lands at the root; import preserves depth-3
   trees.

About 26 existing test files mention grandchildren. Most seed with direct
inserts or board actors, which stays valid. Fix only the real failures (likely
`issue-thread-interaction-routes.test.ts` and `issues-service.test.ts`).

## Open decisions

1. **Agent moves a task that has children.** Skip the parent change with a
   notice (recommended), or also lift its children to siblings (this mutates
   other tasks).
2. **User-accepted agent suggestions.** Flatten (recommended; the agent
   authored the shape), or treat acceptance as a user action and allow nesting.
3. **Plugins.** Flatten (recommended), or allow nesting when the plugin acts in
   a user-initiated UI action.
4. **`origin_run_id` overload for routines.** Keep the routine-run id there and
   document that `origin_run_id` means "the run record that created it"
   (recommended; no churn), or add `origin_heartbeat_run_id` and keep routine
   runs separate.
5. **Chat tool parent scope.** Allow only parents created from the same
   conversation (recommended), or any task the agent may write.
