# Built-in Agents

Built-in agents are first-party, company-scoped agents that Paperclip can resolve by a stable registry key. They are normal rows in `agents`, but they carry immutable metadata under `metadata.paperclipBuiltInAgent` so services can find them without hardcoding a database id.

The first built-ins are `briefs` and `learning`. Operators can provision them from the API without going through board hire approval, but the route still requires the same `agents:create` permission as normal agent creation.

## Runtime Model

The subsystem has four layers:

- Registry: `server/src/services/built-in-agents.ts` defines the static `BuiltInAgentDefinition` list.
- Marker: `server/src/services/built-in-agent-metadata.ts` reads and writes `metadata.paperclipBuiltInAgent`.
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
