# Built-in Agents

Built-in agents are first-party, company-scoped agents that Paperclip can resolve by a stable registry key. They are normal rows in `agents`, but they carry immutable metadata under `metadata.paperclipBuiltInAgent` so services can find them without hardcoding a database id.

The built-ins are `briefs`, `learning`, `judge`, `reflection-coach`, and `summarizer`. Operators can provision them from the API without going through board hire approval, but the route still requires the same `agents:create` permission as normal agent creation.

## Runtime Model

The subsystem has four layers:

- Registry: `server/src/services/built-in-agents.ts` defines the static `BuiltInAgentDefinition` list.
- Marker: `server/src/lib/built-in-agent-metadata.ts` reads and writes `metadata.paperclipBuiltInAgent`.
- Provisioning service: `builtInAgentService(db)` finds, creates, updates, resets, and requires built-ins per company.
- Routes: `server/src/routes/built-in-agents.ts` exposes list, provision, and reset APIs.

Built-in agent state is derived from the marked agent row:

- `not_provisioned`: no active marked row exists for the company/key.
- `needs_setup`: a row exists, but adapter config is incomplete for the adapter type.
- `ready`: adapter config is complete and the agent is not paused.
- `paused`: the marked row is paused. Scheduled/background work should log the paused warning and skip queueing work.

Use `builtInAgentService(db).requireBuiltInAgent(companyId, key)` from backend features that need a built-in agent before scheduling work. It throws HTTP 412 with `code: "built_in_agent_not_configured"` for missing or incomplete agents. Paused agents return the agent plus a `built_in_agent_paused` warning so callers can pass the warning through to logs or API responses without treating the agent as ready for scheduling.

## API

All routes are company-scoped:

- `GET /api/companies/:companyId/built-in-agents`
  Lists registry definitions with current company state.
- `POST /api/companies/:companyId/built-in-agents/:key/provision`
  Creates or configures the built-in for the company. Body accepts optional `adapterType` and `adapterConfig`.
- `POST /api/companies/:companyId/built-in-agents/:key/reset`
  Restores registry-owned display/default fields on the marked row while preserving operator adapter setup.

Provision and reset require `agents:create`. Provision intentionally skips `requireBoardApprovalForNewAgents` because built-ins are registry-owned system capacity, not ad hoc hires.

## Add a New Built-in Agent

1. Add a definition in `DEFINITIONS` inside `server/src/services/built-in-agents.ts`.
2. Pick a stable lowercase `key` using only letters, numbers, `_`, and `-`. Do not rename keys after release.
3. Set `displayName`, `shortPurpose`, `defaultInstructions`, `defaultRole`, and at least one `featureKeys` entry.
4. Set `allowedAdapterTypes` to the smallest set that actually works for this built-in.
5. Decide whether the built-in needs a nonzero `defaultBudgetMonthlyCents`.
6. Add or update tests in `server/src/__tests__/built-in-agents.test.ts`.
7. If the built-in is surfaced in UI or docs, add those changes in the same PR.
8. Run the focused tests from the repo root with `pnpm --filter @paperclipai/server exec vitest run src/__tests__/built-in-agents.test.ts src/__tests__/built-in-agent-routes.test.ts`.

Do not write built-in markers directly through generic agent create/update routes. The agent service rejects marker add, remove, and mutation unless the built-in service explicitly opts in.

### `defaultInstructions` is not materialized on its own

`defaultInstructions` is a registry declaration. It is validated, and it is redacted out of
list responses as `[file-backed]`, but the provisioning service only writes an agent's
instruction files from `bundle.instructions.files`. A built-in without a `bundle` therefore
gets an agent row with **no `AGENTS.md`** until an operator writes one.

Two ways to close that gap, in order of preference:

- Give the built-in a `bundle`. A bundle always ships instructions, a skill, and a routine,
  and the routine is what drives the built-in on a schedule. The cost is that the bundle
  also owns a company skill.
- Keep the definition bundle-free and materialize `AGENTS.md` after provisioning with
  `PUT /api/agents/{id}/instructions-bundle/file`. Keep the contract text in the repo (for
  example `server/src/built-ins/agents/<key>/AGENTS.md`, read into `defaultInstructions` with
  `readBuiltInText`) so the registry declaration and the file on disk cannot drift apart.

`judge` and `learning` use the second option: their contracts live in
`server/src/built-ins/agents/<key>/AGENTS.md`, and their schedules are ordinary company
routines created against the provisioned agent.

### Budget semantics for built-ins

`defaultBudgetMonthlyCents: 0` means **no monthly cap**, not "blocked". The budget service
skips policies whose amount is not positive, so a zero-budget agent still runs.

Two traps follow from that, and they pull in opposite directions:

- An agent with no cap cannot be stopped by an operator raising or lowering a budget.
- A *nonzero* cap is enforced, and a policy blocks its scope when the observed spend reaches
  the amount, when completed runs are still awaiting accounting, **or** when the scope has
  unpriced usage and the policy's `unpricedUsagePolicy` is `block` (the default). Local
  adapters that report tokens without a cost produce unpriced usage, so a nonzero budget
  plus unpriced usage blocks the agent from starting new work.

Give a built-in a nonzero budget, then check its policy with
`POST /api/companies/{companyId}/budgets/policies` and set `unpricedUsagePolicy` to `allow`
when the adapter cannot price its usage.

## Worked Example: `digest`

Hypothetical registry diff:

```diff
 const DEFINITIONS = validateBuiltInAgentDefinitions([
   {
     key: "learning",
     displayName: "Learning Agent",
     featureKeys: ["learning"],
     shortPurpose: "Maintains reusable company learning from completed work and recurring patterns.",
     defaultInstructions:
       "You are Paperclip's built-in Learning agent. Extract durable lessons from completed work, preserve useful patterns, and keep learning artifacts grounded in source context.",
     defaultRole: "general",
     allowedAdapterTypes: ["codex_local", "claude_local", "gemini_local", "opencode_local", "process"],
     defaultBudgetMonthlyCents: 0,
   },
+  {
+    key: "digest",
+    displayName: "Digest Agent",
+    featureKeys: ["digest"],
+    shortPurpose: "Summarizes recent company activity into a board-readable digest.",
+    defaultInstructions:
+      "You are Paperclip's built-in Digest agent. Produce short, sourced summaries of recent company activity, decisions, blockers, and next actions.",
+    defaultRole: "general",
+    allowedAdapterTypes: ["codex_local", "claude_local", "process"],
+    defaultBudgetMonthlyCents: 0,
+  },
 ]);
```

Add focused test coverage:

```ts
expect(listBuiltInAgentDefinitions().map((definition) => definition.key).sort()).toEqual([
  "briefs",
  "digest",
  "learning",
]);
```

If a background job needs the agent:

```ts
const { agent, warning } = await builtInAgentService(db).requireBuiltInAgent(companyId, "digest");
if (warning) {
  logger.info({ warning }, "Skipping digest work because built-in agent is paused");
  return;
}

await heartbeatService(db).wakeup(agent.id, {
  source: "automation",
  triggerDetail: "system",
  reason: "Generate company digest",
});
```

If the agent is missing or not configured, the helper throws:

```json
{
  "error": "Built-in agent is not configured: digest",
  "code": "built_in_agent_not_configured",
  "details": {
    "code": "built_in_agent_not_configured",
    "key": "digest",
    "status": "needs_setup",
    "agentId": "..."
  }
}
```

## Worked Example: `judge`

`judge` is a real built-in. It re-runs an external criteria check against a delivery receipt
and records a machine verdict. It is deliberately bundle-free: it owns no company skill and
no routine, because a judge that can edit the thing it judges is not a judge.

```diff
+  {
+    key: "judge",
+    displayName: "Judge Agent",
+    featureKeys: ["judge"],
+    shortPurpose:
+      "Runs the external criteria check independently and records a machine verdict for a delivery receipt.",
+    defaultInstructions: JUDGE_INSTRUCTIONS,
+    defaultRole: "general",
+    defaultManager: "single_root_agent",
+    allowedAdapterTypes: ["codex_local", "claude_local", "gemini_local", "opencode_local", "process"],
+    defaultBudgetMonthlyCents: 5000,
+  },
```

`JUDGE_INSTRUCTIONS` is read from `server/src/built-ins/agents/judge/AGENTS.md` with
`readBuiltInText`, so the registry declaration and the file on disk are the same text.

`learning` is its counterpart and follows the same shape. It extracts lessons from delivery
receipts and writes a new version of the delivery methodology skill, but it never installs
that version: the human gate is a `request_confirmation` on the issue thread, and the
delivery workers stay pinned to the previous skill version until a human accepts and an
executor re-points them.

Two request-shape details decide whether that gate exists at all:

- `resolverPolicy` goes at the **top level** of the interaction body, next to `kind`. The
  default is `anyone`, which lets the creating agent resolve its own confirmation.
- `payload.version` is **required** and must be the integer `1`. A body without it is a
  400, and an agent that gets a 400 learns nothing.

A third detail decides whether the gate can be **judged**. The target carries the proposed
version id:

```json
"target": { "type": "custom", "key": "skill:<skillId>", "revisionId": "<the proposed version id>" }
```

The judge rules on one version id, and the version id is what says which bytes a verdict
covers. Without it the confirmation names only the skill, the next proposal moves the library
head, and nothing identifies the version the human was asked to accept. The proposed version
id also belongs in the proposal comment, for the same reason.

### The learner needs the read-side peer grant

`learning` carries two default grants, and the split between them is the separation of
duties:

- `skills:suggest-changes` puts the skill edit in the suggest lane. Which skill it may
  touch is decided by the company skill policy, not by the grant, so a company has to
  pair it with an explicit rule.
- `agents:suggest-changes` is the read-side peer grant, and the learner needs it to do
  the job correctly. A proposal has to be built on the version that is **live**, and the
  only record of that is the pin on the agent that runs the skill
  (`GET /api/agents/{agentId}/skills` -> `desiredSkillEntries[].versionId`). The library
  head - `currentVersionId` on the skill record - only says which version was written
  last, and every proposal moves it. After a human rejects a proposal, the head *is*
  the rejected document, so a learner that reads the head proposes a descendant of what
  the human just turned down.

The read grant does not give the learner the power to install. `agent_config:update` on
a peer still requires `agents:configure` or an accepted change consent, and installing a
skill version is a human decision on the confirmation. Reading what is live and moving
it stay separate acts.

The pin has to exist. A worker without a pin runs the library head, and writing a version
moves the head, so a proposal written against an unpinned skill reaches the worker before
the judge rules on it and before the human accepts it. The learner contract therefore makes
the learner stop and ask an operator to pin the workers when it finds no pin. An operator
who wants the loop to run has to pin the delivery workers first.

Do not rely on the agent remembering either of them. `companies.interactionResolverGovernance`
caps the resolver policy per interaction kind, and the cap wins over what the agent asked
for:

```sh
curl -X PATCH "$PAPERCLIP_API_URL/api/companies/$COMPANY_ID" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"interactionResolverGovernance":{"request_confirmation":{"cap":"human_only"}}}'
```

With that cap, no agent run in the company can resolve a `request_confirmation` - not even
the run that created it. The gate stops depending on the proposer's good intentions.

Both agents need a schedule to turn. With no bundle there is no bundle routine, so create an
ordinary company routine against the provisioned agent:

```sh
curl -X POST "$PAPERCLIP_API_URL/api/companies/$COMPANY_ID/routines" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Adjudicate delivery receipts",
    "description": "Re-run the external criteria check for every queued delivery receipt and post one verdict per adjudication issue.",
    "assigneeAgentId": "<judge agent id>",
    "priority": "high",
    "status": "active",
    "concurrencyPolicy": "coalesce_if_active",
    "catchUpPolicy": "skip_missed"
  }'
```

Then add a schedule trigger on the routine and enable it.

## PR Checklist

- Registry definition has a stable key and at least one feature key.
- `allowedAdapterTypes` is intentionally narrow.
- Provisioning does not require board hire approval.
- Generic agent create/update cannot forge or remove the marker.
- Routes remain company-scoped and write activity for mutations.
- Background consumers use `requireBuiltInAgent(companyId, key)` instead of open-coding marker lookup.
- Paused built-ins skip scheduled/background work and leave an inspectable log or warning.
- Focused tests pass:

```sh
pnpm --filter @paperclipai/server exec vitest run src/__tests__/built-in-agents.test.ts src/__tests__/built-in-agent-routes.test.ts
```

## Operational Notes

- One active built-in row per company/key is allowed. Duplicate active markers are treated as a conflict and must be repaired manually.
- Terminated built-in rows are ignored for lookup; provisioning can create a replacement.
- `reset` restores registry-owned defaults but preserves adapter setup so operators do not lose local model or command configuration.
- Unknown marker keys are ignored during startup reconciliation. This prevents removed experimental built-ins from breaking server boot.
- Feature code should treat 412 `built_in_agent_not_configured` as an operator setup problem, not as a 500.
