---
name: agents-studio
description: >
  Use the AI Factory's Agents Studio to fulfil a goal: create specialized agents
  (HR, Finance, IT, etc.), author a workflow that stitches integrator actions
  together, and run it. Running compiles the workflow into real Paperclip issues
  assigned to agents, which the engine then executes. Use when asked to "build an
  agent", "automate an HR/Finance/IT process", "create a workflow", or to deliver
  a goal by standing up agents + automation.
---

# Agents Studio Skill

Agents Studio is the authoring front-door of the AI Factory. You use it to turn a
goal into **real agents + a workflow**, then hand execution to the existing
Paperclip engine (issues + heartbeats). You do **not** invent a separate runtime —
running a workflow creates issues that assigned agents execute for real.

## Mental model

```
Goal  →  create agent(s)  →  author workflow (stitch integrator actions)  →  run
                                                                              │
                                                            run = create issues + wake agents
                                                                              │
                                                                  existing engine does the work
```

- **Agents** are real rows in the org (the same agents shown in the org chart).
- **Integrators** are the enterprise systems (ServiceNow, BambooHR, NetSuite,
  Coupa, SAP, Workday, Jira). Each exposes typed **actions** a step calls.
- **Workflow** = an ordered list of steps; each step = an integrator action
  assigned to an agent.
- **Run** = compile the workflow into a parent issue + one child issue per step,
  assigned to the step's agent, and wake those agents. Real work follows.

## Preconditions

You need board access, or agent permission `can_create_agents=true`. If you lack
it, escalate to your CEO or board.

## Workflow

### 1. Confirm identity and company

```sh
curl -sS "$PAPERCLIP_API_URL/api/agents/me" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"
# capture the companyId from the response → $COMPANY
```

### 2. Discover the integrators (the action vocabulary)

```sh
# Static catalog (systems + actions + auth):
curl -sS "$PAPERCLIP_API_URL/api/agents-studio/integrators" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"

# This company's connection status:
curl -sS "$PAPERCLIP_API_URL/api/companies/$COMPANY/integrators" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"
```

Pick the integrator `key`s (e.g. `hr`, `workday`, `it`, `jira`) and the
`action` keys (e.g. `hr.employee.onboard`, `workday.position.create`) the goal
needs.

### 3. Create the specialized agent(s)

Create one agent per role the goal requires. `domain` is one of
`it | hr | finance | procurement | general`. `allowedIntegrators` is the list of
integrator keys this agent may use.

```sh
curl -sS -X POST "$PAPERCLIP_API_URL/api/companies/$COMPANY/agents-studio/agents" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "HR Onboarding Agent",
    "domain": "hr",
    "instructions": "Owns new-hire onboarding end to end.",
    "allowedIntegrators": ["hr", "workday", "it"]
  }'
# capture the returned agent.id → $AGENT
```

List existing agents (to reuse or to get ids for step assignment):

```sh
curl -sS "$PAPERCLIP_API_URL/api/companies/$COMPANY/agents-studio/agents" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"
```

### 4. Author the workflow (stitch integrator actions)

Each step references an integrator (`connector`) + `action`, and is assigned to
an agent via `assigneeAgentId`. Use `core` / `agent.prompt` for a reasoning step.

```sh
curl -sS -X POST "$PAPERCLIP_API_URL/api/companies/$COMPANY/workflows" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Employee Onboarding",
    "status": "active",
    "steps": [
      { "id": "s1", "name": "Create HR record", "connector": "hr",
        "action": "hr.employee.onboard", "assigneeAgentId": "'"$AGENT"'", "config": {} },
      { "id": "s2", "name": "Create Workday position", "connector": "workday",
        "action": "workday.position.create", "assigneeAgentId": "'"$AGENT"'", "config": {} },
      { "id": "s3", "name": "Provision IT access", "connector": "it",
        "action": "it.access.grant", "assigneeAgentId": "'"$AGENT"'", "config": {} }
    ]
  }'
# capture the returned workflow.id → $WF
```

Shortcut — deploy a ready-made blueprint instead of authoring from scratch:

```sh
curl -sS "$PAPERCLIP_API_URL/api/agents-studio/templates" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"        # list blueprint keys

curl -sS -X POST "$PAPERCLIP_API_URL/api/companies/$COMPANY/workflows/deploy" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "templateKey": "hr-employee-onboarding" }'
```

### 5. Run it — compiles to real issues + wakes agents

```sh
curl -sS -X POST "$PAPERCLIP_API_URL/api/companies/$COMPANY/workflows/$WF/run" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "trigger": "manual" }'
```

This creates a parent issue plus one child issue per step (assigned to the
step's agent) and wakes the assignees. From here the **existing engine** runs
those agents — including real software work (e.g. "build app X" or "refactor
module Y") when the step is assigned to an engineering agent.

### 6. Track the produced work

The run response lists each step's created task. Follow the issues on the board
(`/issues`) or via the API; their status, comments, and work products are the
real output. Group related runs under a **goal** when delivering a larger
objective.

### 7. Call integrator actions as tools (live APIs)

Every connected integrator exposes its actions as callable tools. Discover them:

```sh
curl -sS "$PAPERCLIP_API_URL/api/companies/$COMPANY/integrators/tools" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"   # → { tools: [...] }
```

Each tool lists its `endpoint` and `body`. Invoke one — credentials live in the
secrets vault and are injected **server-side**, so you never handle secrets:

```sh
curl -sS -X POST "$PAPERCLIP_API_URL/api/companies/$COMPANY/integrators/servicenow/run-action" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "action": "incident.create", "inputs": { "short_description": "Laptop won'"'"'t boot" } }'
```

When a workflow step runs, its task body already lists the integrator tools
available to the assigned agent — call them directly to do the real work.

## Notes

- Don't build a parallel tracker. A "factory order" is just an issue (optionally
  under a goal). Lifecycle = issue status + plan decomposition.
- Integrator credentials are stored in the Paperclip **secrets vault**
  (`local_encrypted`), never in plaintext config; `run-action` resolves them at
  call time. Connect an integrator on the Integrators page to supply them.
- Keep one agent per clear responsibility; grant only the integrators it needs.
