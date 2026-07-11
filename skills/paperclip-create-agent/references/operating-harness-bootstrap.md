# Operating-Harness Bootstrap

Use this workflow when a CEO bootstraps a company, revisits its roster after a
mission or workload change, or considers a roster-driven hire. The goal is the
smallest complete operating harness for the company's actual work, not a
standard org chart.

## Contents

- [Rules](#rules)
- [Inspect current company state](#1-inspect-current-company-state)
- [Derive capability demand](#2-derive-capability-demand)
- [Write one durable assessment](#3-write-one-durable-assessment)
- [Act on the assessment](#4-act-on-the-assessment)
- [Delegate with outcome controls](#5-delegate-with-outcome-controls)
- [Anti-patterns](#anti-patterns)

## Rules

- Scope every read and decision to `PAPERCLIP_COMPANY_ID`.
- Treat capability fit as authoritative. Titles and lane examples are descriptive.
- Reuse active agents and pending hire approvals before proposing another agent.
- Never copy a live agent, instructions bundle, reporting line, credential setup,
  or secret binding from another company.
- Never require a particular first hire, agent name, role title, or headcount.
- Keep useful planning and unblocked work moving while a hire waits for approval.
- Reruns update one durable assessment. They do not create duplicate hires.

## 1. Inspect current company state

Read the minimum current-company evidence needed to understand intent, work, and
coverage:

```sh
curl -sS "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"

curl -sS "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/goals" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"

curl -sS "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/issues?status=backlog,todo,in_progress,in_review,blocked" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"

curl -sS "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/agents" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"

curl -sS "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/org" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"

curl -sS "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/approvals?status=pending" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"
```

When authorized, inspect `agent-configurations`, company skills, and company MCP
assignments to verify runtime, tool, environment, and secret-binding access. Do
not infer capability from a role name alone.

Summarize:

- company mission, goals, and current priorities
- recurring and near-term work types
- material risk, external systems, deployment surfaces, and evidence obligations
- current agents, status, reporting lines, capacity, runtime, skills, tools, and access
- pending hire approvals and the capability each already intends to cover

## 2. Derive capability demand

Map actual work into capability lanes. Start with these examples and keep only
what the mission and workload justify:

- **Product and coordination:** convert intent into priorities, contracts,
  decisions, and coherent cross-lane sequencing.
- **Build and operations:** implement, configure, run, and maintain the product or
  business workflow.
- **Independent verification or QA:** test intended outcomes against acceptance
  checks and evidence without relying only on the builder's claim.
- **Deployment and recovery:** release, observe, roll back, and recover live
  systems when the company operates production surfaces.
- **Domain capability:** security, data, finance, legal, growth, design, research,
  or another specialty only when the work requires that judgment or access.

These are capabilities, not mandatory jobs. One agent may cover multiple lanes
when access, capacity, and conflict-of-interest rules allow it. Separate builder
and verifier ownership when the contract, risk, or board requirement calls for
independent review.

For each demanded capability, name the expected output, required access, review
independence, expected load, and escalation path. A missing title is not a gap.
A gap exists only when current or pending in-company agents cannot safely cover
real work with the required access, capacity, authority, and evidence bar.

## 3. Write one durable assessment

Create or update an `Operating harness assessment` issue document on the
onboarding or planning issue, then register it as a `document` issue work product
using its document UUID, URL, or another durable external id. You may summarize
the assessment in an issue comment, but a comment or unregistered document alone
does not satisfy the onboarding completion contract. Use this shape:

```md
## Operating harness assessment

- Company: <company id and name>
- Trigger: <initial bootstrap or material delta>
- Inputs checked: <mission/goals/work/roster/approvals plus timestamps>

| Capability demand | Required output and evidence | Current or pending coverage | Access proof | Independent review | Gap |
| --- | --- | --- | --- | --- | --- |
| <derived capability> | <artifact and acceptance proof> | <in-company agent or pending approval> | <verified access> | <owner or not required> | <yes/no and reason> |

### Decisions
- Reuse: <existing coverage>
- Missing capability: <gap, or none>
- Proposed change: <smallest justified hire or configuration change>
- Planning that continues now: <contracts, evidence design, or unblocked work>
- Escalation: <owner, trigger, and structured decision path>
- Reassess when: <mission, workload, access, capacity, or roster trigger>
```

On a rerun, compare the latest inputs with this assessment. Preserve decisions
whose evidence is still current, amend changed rows, and reconcile pending hire
approvals before proposing anything new.

## 4. Act on the assessment

If there is no gap:

- route work to the verified in-company owner
- update the durable assessment
- do not submit a hire request

If a real gap remains:

1. Use an issue-thread `suggest_tasks`, `ask_user_questions`, or
   `request_confirmation` interaction when the board must choose scope, budget,
   authority, or a material tradeoff. Do not ask for the decision only in prose.
2. Continue CEO-owned planning, contract drafting, acceptance design, evidence
   mapping, and any unrelated executable work while the decision is pending.
3. After the decision, use this skill's normal workflow to draft the least-
   privilege agent and submit `POST /api/companies/{companyId}/agent-hires` with
   the source issue. The resulting hire approval is the auditable authorization.
4. Link the approval to the source issue and record which assessment row and
   revision it closes. Do not submit another hire while an equivalent approval
   is pending.

Never assign a lane to an incapable agent merely to make the board look active.
Never mark the entire plan blocked when only one capability-dependent slice is
waiting.

## 5. Delegate with outcome controls

Every execution lane created from the assessment must carry a hidden
`executionContract` with:

- objective and owner
- source of truth and constraints
- acceptance checks
- required evidence outputs or registered work products
- independent reviewer when required
- current blocker, next action, and manager reasoning
- escalation owner, trigger, and authorized recovery options

Completion requires the named evidence to be registered as a qualifying issue
work product, not a successful process exit, status comment, or unregistered
document/attachment. Route normal recovery through `reportsTo`. Escalate to the board through
a structured interaction or approval only for authority, budget, risk, or
business tradeoffs that an agent cannot decide.

## Anti-patterns

- hiring a fixed "first engineer" before inspecting the company
- equating a missing title with a missing capability
- creating one agent per example lane regardless of workload
- duplicating an active agent or pending hire approval
- copying another company's live agent or credentials
- stopping useful planning until every hire is approved
- letting a builder self-certify evidence that requires independent verification
- asking the board to route routine work or interpret unchanged retry state
