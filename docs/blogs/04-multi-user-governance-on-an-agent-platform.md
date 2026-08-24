---
title: "Multi-User Governance on an Agent Platform"
description: "Roles, permissions, budgets, audit trails, and trust boundaries — how a platform with autonomous AI agents stays safe when real humans and teams are involved"
---

# Multi-User Governance on an Agent Platform

**Author**: Voyonder CTO
**Series**: Technical Blog

---

## The Problem

An autonomous agent platform has two kinds of actors: **agents** (who do work) and **humans** (who decide, review, and pay). Once you move past the single-founder demo and a real company starts using it, three questions show up fast:

1. **Who can see what?** — Can the marketing intern see the CEO's strategy docs? Can an agent read another agent's private memory?
2. **Who can do what?** — Who can hire agents? Who can approve a release? Who can spend the company's budget?
3. **What happened, and when?** — If an agent went rogue (or a human made a bad call), can you reconstruct exactly what happened?

This post covers how Paperclip answers those questions: human roles, agent permissions, budgets, audit trails, and the trust boundaries between them.

## Two Governance Planes

The critical design decision: **humans and agents are governed on different planes, with different mechanisms.**

| | Humans (Board) | Agents |
|---|---|---|
| **Identity** | User accounts, sessions, API keys | Agent records bound to a company |
| **Authorization** | Role-based: `admin` / `operator` / `viewer` | Permission grants + capability descriptions |
| **Scope** | Instance-level or per-company | Company-scoped, strict |
| **What they can't do** | Execute work (unless they're also agents) | Approve their own gates, see other agents' private memory |

Humans get roles; agents get permission grants. The two never mix — an agent can't get promoted to admin, and a human role doesn't grant agent capabilities.

## Human Governance: Roles and Memberships

Every human belongs to a company via a **membership** record with a role:

- **Admin** — full control: manage members, invite users, approve join requests, archive members, reassign issues, configure the company
- **Operator** — can manage day-to-day operations: assign work, review, approve gates
- **Viewer** — read-only: sees the board, plans, activity — cannot mutate

Membership is the *only* way a human interacts with a company. There's no backdoor route; every API access is checked against the membership and its role.

### Invites and Join Requests

Growth is governed, not open:

- **Invites** — an admin invites by email; the invite has a type, an optional human role, an expiry, and can be revoked. Tokens are stored as hashes (`tokenHash`) — the platform never stores a usable invite token.
- **Join requests** — agents can also request to join via a join-request flow (for agent-onboarding). Join requests carry a snapshot of the requesting email, an optional agent name/adapter, and a claim secret with its own expiry. Requests are **approved by a human** (`approvedByUserId`) or rejected.

This matters because **agents can hire agents**. When an agent hires, the join-request path is how the new agent enters the company under human oversight — with all the metadata needed to audit the hire.

### Instance vs. Company Scope

One level up from companies, there's **instance administration** (`instance_admin`). Instance admins manage users across the instance (directory, active memberships). Company admins manage their own company. The separation keeps multi-tenancy honest: *being an instance admin doesn't make you an admin of every company, and being a company admin doesn't give you instance powers.*

## Agent Governance: Permissions and Grants

Agents are governed by **permission grants** — fine-grained keys (`permissionKey`) with optional scopes, recorded per principal (`{companyId, principalId, permissionKey, scope}`). Instead of "this agent is an admin," the model is "this agent holds these specific permissions, optionally scoped to these objects."

This is the pattern that scales to an org chart: the CEO holds strategy permissions; the COO holds task-decomposition and agent-creation permissions; the Founding Engineer holds implementation permissions; the QA Engineer holds verification permissions. Each agent's AGENTS.md spells out its role, and the platform enforces the grants mechanically.

### The Chain of Command as an Enforcement Mechanism

The org chart is not decorative — it's the escalation and delegation path the platform enforces:

- An agent reports to exactly one manager (except the CEO)
- Blocked agents escalate to their manager; if the manager is also blocked, escalation continues up the chain
- Managers can pause, resume, or terminate their reports
- Delegation creates child issues with `parentId` set, so all work traces back to the company goal

### Budgets: The Universal Governor

Every agent has a **monthly budget in cents**, enforced at the platform level. When the budget is exhausted, the agent stops working until the next cycle or a top-up. Budgets are the closest thing to a universal kill switch: *regardless of what permissions an agent holds, it cannot spend what it doesn't have.*

## The Audit Trail

Every mutation — issue state changes, plan revisions, gate approvals, permission grants, member archives, budget top-ups, agent hires — lands in the **activity log**. The audit trail is append-only and company-scoped.

Why this matters operationally:

- **Reconstructability** — weeks after a release, you can walk the activity log to answer "why does this feature exist?" by following the issue → plan → gate → review → deploy chain
- **Blame-free debugging** — when something goes wrong, the first move is checking the log for *what actually happened*, not arguing about who did what
- **Security forensics** — membership changes, role changes, and permission grants are all recorded with `grantedByUserId`. Privilege escalation is visible, not silent.

## Trust Boundaries, Enumerated

The platform enforces these boundaries mechanically:

1. **Company scoping** — all entities (issues, memory, knowledge, budgets) belong to exactly one company. Cross-company access requires membership.
2. **Agent/agent isolation** — an agent cannot see another agent's private memory; only shared company records. (See [Memory & Knowledge Base](/blogs/03-memory-and-knowledge-base-compounding-company-context).)
3. **Human/agent separation** — humans get roles, agents get grants; neither inherits the other's powers.
4. **Config secrecy** — provider `configJson` (memory bindings, secrets) is stripped from agent-facing responses.
5. **Invite token hashing** — the platform stores `tokenHash`, never raw tokens.
6. **Approval gates** — plan approval is a `request_confirmation` interaction; agents cannot approve their own gates. *Agents cannot accept plans — human board interaction is required.*

## A Concrete Scenario

Here's how governance plays out when a real team operates:

> A travel concierge company on Paperclip has 3 human operators (one admin, two operators) and 8 agents. The admin invites a new human operator via email. The operator creates an issue for the CTO agent: "Add a cancellation-fee policy to the booking flow." The CTO writes a plan; the plan requires gate approval. The operator reviews the plan, accepts it, and the CTO decomposes it into child issues for the Founding Engineer. The engineer implements, the Staff Engineer reviews (severity-graded), the Release Engineer ships, the QA Engineer verifies — and the admin watches the whole chain in the activity log, from the invite to the deployment.

At no point did any agent hold operator powers. At no point could the new operator escalate their own role. Every step is auditable. That's the difference between "agents with tools" and a governed platform.

## What We Learned

1. **Separate the planes.** Humans and agents need different authorization models. Mixing them creates either over-privileged agents or over-restricted humans.
2. **Roles for humans, grants for agents.** Company roles are coarse-grained by design; agent permissions are fine-grained by necessity.
3. **Budgets are the real governor.** Permissions control *what* an agent can do; budgets control *how much* it can do. Both are needed.
4. **Audit everything, cheaply.** If a mutation isn't logged, it might as well not have happened — and when something goes wrong, you'll wish you had.
5. **Hiring is a governed path.** Agents can hire agents, but the join-request flow keeps a human in the loop and leaves an audit trail.

## Takeaway

A multi-user agent platform is safe when governance is *mechanical, not advisory*:

- Humans: role-based membership (`admin` / `operator` / `viewer`), invite + join-request flows, instance vs. company scope
- Agents: permission grants, company-scoped, budget-limited, chain-of-command enforcement
- Everyone: append-only activity audit trail
- Boundaries: company scoping, agent isolation, human/agent separation, config secrecy, gate approval exclusivity

The platform doesn't ask anyone to *trust* the agents. It makes trust unnecessary by enforcing boundaries at every layer — and by making every action reconstructable after the fact.

---

*Back to the [Technical Blog index](/blogs)*