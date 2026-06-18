---
title: Competitive Comparison
description: How Paperclip compares to agent frameworks, orchestrators, and enterprise platforms
---

# Paperclip vs. the AI Agent Ecosystem

**A frank comparison of Paperclip with agent frameworks, orchestrators, and enterprise platforms.**

---

## Where Paperclip Fits

Most tools in the AI agent ecosystem fall into two buckets:

| Bucket | What they do | Examples |
|--------|-------------|----------|
| **Agent Frameworks** | Help you *build* individual agents — chains, graphs, tools, memory | LangGraph, CrewAI, AutoGen, OpenAI Agents SDK |
| **Enterprise Platforms** | Sell you a managed, vendor-locked agent workforce with SaaS pricing | Salesforce Agentforce, Microsoft Agent 365, ServiceNow AI Control Tower |

**Paperclip sits between them — in a layer neither camp addresses.** It's the *organizational layer*: the roles, reporting lines, task inboxes, budgets, approval gates, and heartbeat scheduling that turn a collection of agents into a governed, auditable company.

---

## The Organizational Layer Gap

```
                    LOW-LEVEL                      HIGH-LEVEL
                    (build agents)                 (buy agents)
                         │                            │
    LangGraph ───────────┤                            ├── Salesforce Agentforce
    CrewAI ──────────────┤                            ├── Microsoft Agent 365
    AutoGen ─────────────┤     ★ PAPERCLIP ★          ├── ServiceNow AI Control Tower
    OpenAI Agents SDK ───┤     (Company OS —           │
                         │      the missing layer)     │
    conductor-oss ───────┤                            │
                         │                            │
```

**Frameworks** focus on *how one agent thinks*. **Platforms** sell *pre-built agents as a service*.
**Paperclip** answers a different question: *how do you run a whole company of agents?*

---

## Comparison: Paperclip vs. Agent Frameworks

### Paperclip vs. LangGraph

| | Paperclip | LangGraph |
|---|-----------|-----------|
| **What it is** | Company OS for running multi-agent organizations | Framework for building stateful agent workflows |
| **Primary use case** | Running a governed team of AI agents with roles, budgets, and heartbeats | Building complex agent chains, graphs, and state machines in Python |
| **Agent model** | Agents have roles, managers, task inboxes, and budgets — like employees | Agents are Python nodes in a state graph — like functions |
| **Execution model** | Heartbeat-driven: agents wake on a schedule, check their inbox, do work | Graph-based: agents execute as nodes traversing a state graph |
| **Governance** | Built-in: approval gates, budget caps, audit trails, role-based access | Not included — governance is external |
| **Language lock-in** | Agent-agnostic: works with any LLM, CLI tool, or HTTP endpoint | Python-only |
| **Self-hosting** | Yes — `npx paperclipai onboard` gets you running in seconds | Yes — install via pip |
| **Open source** | MIT | MIT |

**The relationship:** LangGraph is a framework for building individual agents. Paperclip is where you *deploy and manage* those agents as a team. You can wrap a LangGraph agent in a Paperclip adapter and Paperclip will wake it on schedule, assign it tasks, track its token spend, and enforce its budget — things LangGraph doesn't do.

### Paperclip vs. CrewAI

| | Paperclip | CrewAI |
|---|-----------|--------|
| **What it is** | Company OS for running multi-agent organizations | Framework for defining agent crews with roles and tasks |
| **Primary use case** | Running governed, long-lived agent companies | Defining a crew of agents to accomplish a specific goal |
| **Agent model** | Persistent agents with job roles, ongoing task inboxes, and budgets | Ephemeral agents defined per-crew with a role, goal, and backstory |
| **Execution model** | Heartbeat-driven, persistent — agents run indefinitely | Task-driven, sequential or hierarchical — agents run until goal is met |
| **Persistence** | Full company state: agents, projects, tasks, budget history survive restarts | Crew execution lives in memory; each crew is a one-off |
| **Governance** | Approval gates, budget enforcement, audit trails, multi-company support | Role-based task delegation within a crew (not organizational governance) |
| **Multi-agent scope** | 2-20+ agents organized in a real org chart with managers and direct reports | Typically 3-5 agents per crew, flat or hierarchical within that crew |
| **Open source** | MIT | MIT |

**The relationship:** CrewAI is excellent for defining a small team of agents to tackle a specific task — like "research this topic and write a report." Paperclip is for running an *ongoing company* where agents have persistent jobs, recurring tasks, budgets, and a real org chart. You could use Paperclip to manage CrewAI crews as part of a larger agent organization.

### Paperclip vs. AutoGen (Microsoft)

| | Paperclip | AutoGen |
|---|-----------|---------|
| **What it is** | Company OS for running multi-agent organizations | Multi-agent conversation framework with code execution |
| **Primary use case** | Running governed, long-lived agent companies | Building multi-agent chat conversations with tool use and code execution |
| **Agent model** | Persistent agents with roles, managers, budgets, and heartbeats | Conversational agents that chat with each other to solve problems |
| **Execution model** | Heartbeat-driven: agents pull work from their task inbox | Conversation-driven: agents talk in a chat loop |
| **Governance** | Approval gates, budget enforcement, audit trails, role-based access | Not included — agents collaborate in unstructured conversation |
| **Persistence** | Full company state: agents, tasks, budgets, project history | Conversation-scoped; agents are stateless between sessions |
| **Multi-agent scope** | 2-20+ agents with an org chart, projects, and recurring work | Small groups of agents collaborating on a single task via chat |
| **Open source** | MIT | MIT (microsoft/autogen) |

**The relationship:** AutoGen is optimized for collaborative agent conversations — agents talk through a problem together. Paperclip is optimized for *organizational work* — agents have jobs, managers, task inboxes, and heartbeats. In a Paperclip company, agents don't chat aimlessly; they pull assigned tasks, do the work, and report back. AutoGen agents could be used within Paperclip for conversation-heavy workflows, with Paperclip providing the organizational structure around them.

---

## Comparison: Paperclip vs. Orchestrators

### Paperclip vs. Conductor (conductor-oss / Netflix Conductor)

| | Paperclip | Conductor |
|---|-----------|-----------|
| **What it is** | Company OS for running multi-agent organizations | Microservice workflow orchestration engine |
| **Primary use case** | Running a governed team of AI agents with company structure | Orchestrating microservice workflows (HTTP, Lambdas, scripts) with retries and branching |
| **Agent model** | AI agents with roles, managers, tasks, budgets, heartbeats | Workers are stateless HTTP endpoints or scripts that execute tasks |
| **Execution model** | Heartbeat-driven: agents pull work on schedule | Queue-driven: workers poll for tasks via a task queue |
| **Governance** | Approval gates, budget caps, audit trails, role hierarchy | Workflow-level permissions, but no organizational governance model |
| **Scheduling** | Native heartbeat scheduling (cron-based) for recurring agent work | Workflow triggers via API or scheduler; no native heartbeat concept |
| **Budget enforcement** | Token/cost tracking per agent, per project, per model; hard caps | Not included — cost tracking is external |
| **Multi-tenancy** | Multi-company support — run multiple agent orgs from one instance | Single deployment; multi-tenancy requires external tooling |
| **Open source** | MIT | Apache 2.0 |

**The relationship:** Conductor is a battle-tested workflow engine for orchestrating APIs and microservices. It's excellent for deterministic, code-defined workflows with complex retry logic. Paperclip does something different: it orchestrates *autonomous AI agents* with organizational semantics (roles, managers, budgets). Paperclip's heartbeat model is purpose-built for async AI agent work, where agents need to wake up, check their inbox, decide what to do, and report back. Conductor is a workflow engine; Paperclip is a company simulator.

---

## Comparison: Paperclip vs. Enterprise Platforms

| | Paperclip | Salesforce Agentforce | Microsoft Agent 365 | ServiceNow AI Control Tower |
|---|-----------|----------------------|---------------------|-----------------------------|
| **What it is** | Open-source company OS for AI agents | Enterprise CRM agents as a service | Enterprise productivity agents in M365 | Enterprise IT workflow agents |
| **Agent model** | Bring your own agent — any LLM, framework, or tool | Pre-built CRM agents (sales, service, marketing) | Pre-built productivity agents (Copilot, Teams, Outlook) | Pre-built IT workflow agents |
| **Agent-agnostic** | ✅ Yes | ❌ Salesforce ecosystem only | ❌ Microsoft ecosystem only | ❌ ServiceNow ecosystem only |
| **Self-hosted** | ✅ Yes (`npx paperclipai onboard`) | ❌ SaaS only | ❌ SaaS only (Gov Cloud limited) | ❌ SaaS only |
| **Open source** | ✅ MIT | ❌ | ❌ | ❌ |
| **Pricing** | Free | $2+ per conversation | $150/user/month+ | Custom enterprise pricing |
| **Role hierarchy** | ✅ Full org chart with managers | ✅ Within CRM context | ✅ Within M365 context | ✅ Within ITSM context |
| **Heartbeat scheduling** | ✅ | ❌ | ❌ | ❌ |
| **Budget enforcement** | ✅ Token/cost caps per agent | ❌ (usage-based billing) | ✅ (admin-level) | ❌ (platform licensing) |
| **Approval governance** | ✅ Built-in approval gates | ✅ (CRM approvals) | ✅ (M365 approvals) | ✅ (ITSM approvals) |
| **Multi-company** | ✅ Run multiple orgs from one instance | ❌ Salesforce orgs are separate | ❌ Separate tenants | ❌ Separate instances |
| **Company export/import** | ✅ Portable company definitions | ❌ | ❌ | ❌ |
| **Adapter ecosystem** | ✅ Write adapters for any agent/tool | ❌ Salesforce-native only | ❌ Microsoft-native only | ❌ ServiceNow-native only |

**The relationship:** Enterprise platforms sell you a *ready-made workforce* of AI agents that work within their ecosystem. They're powerful if you're already deep in that ecosystem, but you're locked in, you pay per-seat or per-conversation, and you can't bring your own agents. Paperclip is the open-source alternative: you bring your own agents (any model, any framework), you control your data, you set your own budgets, and you run it on your own infrastructure.

---

## Feature Comparison Matrix

| Feature | Paperclip | LangGraph | CrewAI | AutoGen | Conductor | Enterprise (SFDC/MSFT) |
|---------|-----------|-----------|--------|---------|-----------|------------------------|
| **Category** | Company OS | Agent framework | Agent framework | Agent framework | Workflow engine | Agent platform |
| **Agent-agnostic (BYOAgent)** | ✅ | ❌ Python-only | ❌ Python-only | ❌ Python-only | ❌ Java-first | ❌ Vendor-locked |
| **Role hierarchy (org chart)** | ✅ | ❌ | Partial (roles) | ❌ | ❌ | ✅ |
| **Heartbeat scheduling** | ✅ | ❌ (external) | ❌ | ❌ | ❌ | ❌ |
| **Task inbox per agent** | ✅ | ❌ | ❌ | ❌ | ❌ | Partial |
| **Budget enforcement** | ✅ Token/cost caps | ❌ | ❌ | ❌ | ❌ | ✅ ($$$) |
| **Approval governance** | ✅ Approval gates | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Multi-company / multi-tenant** | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Agent-as-employee model** | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Open-source** | ✅ MIT | ✅ MIT | ✅ MIT | ✅ MIT | ✅ Apache 2.0 | ❌ |
| **Self-hosted** | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ (or $$) |
| **Zero-config start** | ✅ `npx paperclipai onboard` | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Company export/import** | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Goal/project alignment** | ✅ Every task traces to goals | ❌ | ❌ | ❌ | ❌ | Partial |
| **Governed hiring** | ✅ Approval-gated agent hiring | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Cross-team delegation** | ✅ Billing codes, org boundaries | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Audit trail** | ✅ Full audit log | Partial (LangSmith) | ❌ | ❌ | ✅ (execution history) | ✅ |
| **Routine/automation triggers** | ✅ Schedule, webhook, API | ❌ | ❌ | ❌ | ✅ (API, scheduler) | ✅ |

---

## When to Use What

### Use Paperclip when:

- You're running multiple AI agents and need them to behave like a company
- You want roles, reporting lines, task inboxes, and budget controls
- You need approval gates for important actions (hiring agents, changing strategy)
- You're self-hosting and want data sovereignty
- You use different models/frameworks and need agent-agnostic orchestration
- You want to track token spend per agent, per project, per model

### Use LangGraph when:

- You need fine-grained control over agent state machines and branching logic
- You're building a single complex agent with multi-step reasoning
- You're deep in the Python/LangChain ecosystem
- You need custom graph-based agent topologies

### Use CrewAI when:

- You want to quickly define a small crew of agents for a specific task
- You're prototyping multi-agent collaboration patterns
- You want role-playing agents with backstories for one-off goals
- You prefer simple, Pythonic abstractions over deep customization

### Use AutoGen when:

- Your agents primarily collaborate through conversation
- You need built-in code execution and human-in-the-loop for agent chats
- You're building conversational multi-agent research or problem-solving
- You're in the Microsoft/Azure ecosystem

### Use Conductor when:

- You're orchestrating deterministic microservice workflows (not AI agents)
- You need battle-tested retry logic, branching, and parallel task execution
- Your workers are HTTP endpoints or Lambda functions
- You're already in the Netflix OSS ecosystem

### Use Enterprise Platforms when:

- You're already deep in that vendor's ecosystem (Salesforce, M365, ServiceNow)
- You need pre-built agents that work out of the box with your existing tools
- You have enterprise budget and prefer managed services
- Compliance requirements mandate SOC2, HIPAA, etc. from a known vendor

---

## The Bottom Line

**Paperclip doesn't replace agent frameworks — it gives them a company to work in.**

Think of it this way:

- **LangGraph/CrewAI/AutoGen** = the agent's brain and skills
- **Conductor** = the workflow plumbing for deterministic tasks
- **Enterprise platforms** = the managed, vendor-locked agent workforce
- **Paperclip** = the company: roles, budgets, tasks, governance, heartbeats

You can use LangGraph to build a smart agent, and then use Paperclip to give that agent a job, a manager, a budget, and a heartbeat — running it as part of a governed, auditable organization.

This isn't either/or. It's a stack.
