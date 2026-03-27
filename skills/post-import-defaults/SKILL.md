---
name: post-import-defaults
description: >
  Apply intelligent post-import defaults to all agents in a company.
  Analyzes each agent's role, title, skills, and reporting position to
  assign appropriate model tiers, heartbeat intervals, and adapter
  permissions. Use after importing a company package.
---

# Post-Import Defaults Skill

Use this skill after importing a company package to configure all agents with
appropriate models, heartbeat intervals, and permissions. The import process
intentionally disables heartbeats and omits operational settings like
`dangerouslySkipPermissions` — this skill restores them intelligently.

## Workflow

### Step 1: Identify the target company

If the user specifies a company, use that. Otherwise list companies and confirm.

```sh
curl -sf http://127.0.0.1:3101/api/companies
```

### Step 2: Fetch all agents with full config

```sh
curl -sf "http://127.0.0.1:3101/api/companies/<companyId>/agents"
```

### Step 3: Analyze each agent and assign tiers

For every agent, examine its **name**, **title**, **role**, **capabilities**,
**skills list**, and **reporting position** (`reportsTo`). Classify each agent
into one of five tiers:

#### Tier 1 — Leadership & Coordination (opus, 30s heartbeat)

Agents whose primary job is **delegation, oversight, and cross-team
coordination**. They route work to others, approve decisions, and need fast
response times.

Signals:
- Title contains: CEO, CTO, COO, CSO, CISO, "Chief", "Director", "VP"
- Title contains: "Lead" AND agent has no specialized skills (i.e., a
  management-only lead, not a hands-on technical lead with domain skills)
- Role is explicitly managerial (reports-to root, has direct reports)
- Name is "CEO" or similar C-suite

Model: `claude-opus-4-6`
Heartbeat: `30` seconds

#### Tier 2 — Core Workers (sonnet, 60s heartbeat)

Agents that do the **primary, high-volume work** of the organization. They are
generalists or work in the company's core domain with broad tool coverage.

Signals:
- Title contains: "Engineer", "Auditor", "Developer" with broad/multiple skills
- Has 3+ desired skills (indicates a versatile, frequently-used role)
- Title contains: "Lead" AND has domain skills (hands-on technical lead)
- Role maps to the company's primary business (e.g., "Code Auditor" in a
  security firm)

Model: `claude-sonnet-4-6`
Heartbeat: `60` seconds

#### Tier 3 — Domain Specialists (sonnet, 120s heartbeat)

Agents with **clear domain expertise** that are called on regularly but for
more focused work.

Signals:
- Title contains: "Lead" or "Senior" with 1-2 specialized skills
- Has 1-2 desired skills in a specific domain
- Title references a well-defined specialty (blockchain, reverse engineering,
  supply chain)

Model: `claude-sonnet-4-6`
Heartbeat: `120` seconds

#### Tier 4 — Narrow Specialists (sonnet, 180s heartbeat)

Agents with a **single narrow specialty** that are only invoked for specific
task types.

Signals:
- Title contains: "Analyst", "Specialist", "Tester" with exactly 1 skill
- Very narrow capability scope (e.g., "Binary Analyst", "Mobile Security
  Analyst")
- No direct reports, not in leadership chain

Model: `claude-sonnet-4-6`
Heartbeat: `180` seconds

#### Tier 5 — Niche / Rare (sonnet, 300s heartbeat)

Agents that serve **unusual, experimental, or very infrequent** purposes.

Signals:
- Name or title suggests novelty/experiment ("Chaos", "Culture")
- Extremely narrow domain with rare trigger conditions (constant-time
  analysis, zeroization auditing)
- Skills are highly specialized with very low expected task volume

Model: `claude-sonnet-4-6`
Heartbeat: `300` seconds

### Step 4: Present the plan

Before applying, print a table showing each agent's classification:

```
Agent Name                          Tier    Model               Heartbeat
───────────────────────────────────────────────────────────────────────────
CEO                                 1       claude-opus-4-6     30s
Chief Security Officer              1       claude-opus-4-6     30s
Code Auditor                        2       claude-sonnet-4-6   60s
Smart Contract Auditor              3       claude-sonnet-4-6   120s
Binary Analyst                      4       claude-sonnet-4-6   180s
Chaos Agent                         5       claude-sonnet-4-6   300s
...
```

Ask the user to confirm or adjust before applying.

### Step 5: Apply defaults

For each agent, PATCH the config:

```sh
curl -sf -X PATCH "http://127.0.0.1:3101/api/agents/<agentId>" \
  -H 'Content-Type: application/json' \
  -d '{
    "adapterConfig": {
      "dangerouslySkipPermissions": true,
      "model": "<selected-model>"
    },
    "runtimeConfig": {
      "heartbeat": {
        "enabled": true,
        "intervalSec": <selected-interval>
      }
    }
  }'
```

Print results as each agent is updated.

### Step 6: Summary

Print a final summary:
- Total agents updated
- Breakdown by tier
- Any agents that failed

## Rules

- **Always present the plan before applying.** Never batch-update without user
  confirmation.
- **dangerouslySkipPermissions is always true.** Imported agents cannot
  function without it since they have no interactive terminal for approvals.
- **Heartbeats are always enabled.** The whole point of this skill is to wake
  up imported agents.
- **Use the Paperclip API URL from environment** (`$PAPERCLIP_API_URL`) when
  available, otherwise default to `http://127.0.0.1:3101`.
- **If an agent's adapter type is not `claude_local`**, skip the model setting
  (other adapters use different model fields or providers).
- **Respect user overrides.** If the user says "make X an opus agent" or
  "set Y to 45 seconds", honor that over the tier analysis.
