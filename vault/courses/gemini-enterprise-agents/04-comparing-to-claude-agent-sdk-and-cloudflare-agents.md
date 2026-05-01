---
chapter_num: 4
title: "Comparing to Claude Agent SDK + Cloudflare Agents"
course_slug: gemini-enterprise-agent-platform-hands-on-tour
prerequisites_chapters: [1, 2, 3]
duration_min: 55
reading_time_min: 55
date: 2026-04-30
status: draft-for-review
author: Koenig AI Academy
agent_drafted_by: course-author
content_type: course-chapter
ticket: KOE-33
vendor_tag: google
learning_objectives:
  - "Contrast GEAP state management with Claude Agent SDK and Cloudflare Durable Objects"
  - "Identify the deployment topology differences across all three platforms"
  - "Name three workloads where GEAP wins and three where a lighter alternative is preferable"
  - "Apply a vendor-selection framework to a real-world scenario"
sources:
  - https://cloud.google.com/blog/products/ai-machine-learning/introducing-gemini-enterprise-agent-platform
  - https://adk.dev/
  - https://developers.cloudflare.com/agents/
  - https://docs.anthropic.com/en/docs/agents-and-tools
  - https://claude.com/platform/api
---

# Comparing to Claude Agent SDK + Cloudflare Agents

Three production agent platforms — Google's Gemini Enterprise Agent Platform (GEAP), Anthropic's Claude Agent SDK, and Cloudflare Agents — reached general availability between 2024 and April 2026, each offering divergent approaches to state management, deployment topology, and vendor lock-in. This chapter is a structured comparison across 5 dimensions — state, deployment, model access, lock-in surface, and workload fit — so you can choose the right platform for your specific constraints without marketing-driven hype.

## Key facts

1. All three platforms support tool calling, multi-agent patterns, and long-running agents
2. State management is the sharpest architectural divergence: managed SQL (GEAP), you-manage-it (Claude SDK), and [[glossary/durable-objects|Durable Objects]] with built-in SQLite (Cloudflare)
3. Deployment topology: GCP-regional (GEAP), any infra (Claude SDK), Cloudflare global edge ([[course/cloudflare-agents-edge-patterns|Cloudflare Agents]])
4. Vendor lock-in surface: GEAP is highest ([[glossary/memory-bank|Memory Bank]], Registry, Gateway), Claude SDK is lowest (just the Anthropic API), Cloudflare Agents is medium (Durable Objects are Cloudflare-proprietary)
5. Model flexibility: GEAP (200+ models), Claude SDK (Claude models only without manual wiring), Cloudflare Agents (model-agnostic — bring your own provider)
6. Cold-start: Cloudflare (sub-millisecond via edge), GEAP (sub-second with pre-warmed instances), Claude SDK (depends on your infra) [1]

---

## Platform overview

### Gemini Enterprise Agent Platform (GEAP)

GEAP is a fully managed, opinionated platform. You deploy agents to Agent Runtime, state lives in Agent Sessions and Memory Bank (GCP-managed), traffic routes through Agent Gateway, and the Govern/Optimize pillars give you compliance features out of the box. The platform assumes you are building on GCP and treats that as a feature, not a constraint. [1]

**What you give up**: portability. Moving a GEAP agent to AWS or on-premises means rewriting the state layer, the registry layer, and the gateway layer. The ADK (agent logic) is portable; the platform services are not.

### Claude Agent SDK (Anthropic)

The Claude Agent SDK is Anthropic's code-first framework for building agents with Claude models. It is the least opinionated of the three platforms: the SDK gives you tool use, multi-agent coordination primitives, and model access — and leaves infrastructure, state management, and deployment entirely to you.

**What you gain**: maximum portability and model-specific quality. Claude Opus 4.7 is the strongest reasoning model in the current generation for complex multi-step tasks; if your workload requires the highest-quality reasoning and you can manage your own infrastructure, Claude SDK gives you direct access without platform overhead.

**What you give up**: the managed services. There is no equivalent of Memory Bank built in — you build your own long-term memory layer (typically with a vector database and a retrieval pipeline). There is no managed session service — you bring your own database. This is not a flaw; it is the design philosophy. Claude SDK is for builders who want control over every layer.

### Cloudflare Agents

Cloudflare Agents is a TypeScript SDK that runs on Cloudflare Workers, with state managed by Durable Objects. Each agent instance is a Durable Object: a microserver with its own SQLite database, WebSocket support, and scheduling capabilities. The platform runs on Cloudflare's global edge network — 300+ locations, sub-millisecond cold starts. [4]

**What you gain**: edge latency, built-in WebSocket support for real-time interactions, and a state model that does not require an external database. Every agent has its own SQLite database that lives alongside the compute — no network round-trips for state reads.

**What you give up**: the GCP compliance features (no equivalent of Agent Identity, Agent Anomaly Detection, or Security Command Center integration) and the model ecosystem (you wire your own provider). Cloudflare Agents is TypeScript-only — no Python support.

---

## State management: the deepest divergence

How each platform handles state is the most architecturally significant difference. It determines your data model, your failure modes, and your migration path.

### GEAP: managed, layered, opinionated

```python
# GEAP: state is managed by the platform
# You write to session.state; the platform persists it
session.state["expenses"] = expenses

# Memory Bank is automatic — the platform distills Memory Profiles
# from completed sessions. You enable it; you don't implement it.
```

GEAP's state model has two layers: Session state (within-conversation, you write explicitly) and Memory Bank (cross-conversation, platform-distilled). The platform manages persistence, retrieval indexing, and cross-session loading. You do not write database schemas or manage connections.

**Tradeoff**: You cannot easily inspect or migrate raw state. Memory Profiles are generated by Gemini — if the distillation model changes, your Memory Bank contents change subtly. You trust the platform to handle this correctly.

### Claude Agent SDK: bring-your-own-state

```python
# Claude SDK: you manage state yourself
import anthropic
from your_db import get_session, save_session

client = anthropic.Anthropic()
session_data = get_session(user_id)  # your database call

response = client.messages.create(
    model="claude-opus-4-7",
    system=build_system_prompt(session_data),  # you inject state
    messages=conversation_history,
    tools=your_tools,
)

save_session(user_id, updated_session_data)  # your database call
```

The Claude SDK has no built-in state management. Conversation history is a list of messages you pass. Long-term memory is whatever you load into the system prompt. This is complete control — and complete responsibility.

**Tradeoff**: You implement the database layer, the retrieval pipeline, the context compression (conversation history grows indefinitely otherwise), and the cross-session summarisation. This is weeks of engineering for a production-grade implementation. But you own every byte of your data, can inspect it directly, and can migrate it to any platform without data loss.

### Cloudflare Agents: state as a first-class primitive

```typescript
// Cloudflare Agents: state is built into the agent object
import { Agent, callable } from "agents";

export class BudgetAgent extends Agent<Env, { expenses: Expense[] }> {
  initialState = { expenses: [] };

  @callable()
  logExpense(amount: number, category: string): string {
    const expense = { amount, category, date: new Date().toISOString() };
    this.setState({ expenses: [...this.state.expenses, expense] });
    return `Logged: $${amount} on ${category}`;
  }

  @callable()
  getSummary(): string {
    const totals = this.state.expenses.reduce((acc, exp) => {
      acc[exp.category] = (acc[exp.category] || 0) + exp.amount;
      return acc;
    }, {} as Record<string, number>);
    return JSON.stringify(totals);
  }
}
```

Cloudflare's model is elegantly simple: `this.state` is a typed object backed by Durable Object storage (SQLite under the hood). The `setState` call is atomic and immediately consistent. There is no distinction between "session state" and "long-term state" — it is all just state on the Durable Object.

**Tradeoff**: Durable Objects are Cloudflare-proprietary. You cannot run this on AWS or GCP without rewriting the state layer. And `this.state` is per-agent-instance — if a user talks to multiple instances (different edge locations), their state is isolated. Cloudflare has addressed this with Durable Objects' location hints, but cross-region consistency is a genuine complexity.

<KnowledgeCheck
  questions={[
    {
      question: "Your agent needs to remember a user's document preferences across sessions, and your team has a strict data residency requirement that all user data must remain in a specific GCP region. Which platform is the best fit?",
      answers: [
        "Cloudflare Agents, because it has the simplest state model",
        "GEAP, because Memory Bank supports regional data residency within GCP",
        "Claude Agent SDK, because you can deploy to any GCP-hosted database",
        "All three are equivalent for data residency compliance"
      ],
      correct: 1,
      explanation: "GEAP runs on GCP and supports regional deployment. Memory Bank and Agent Sessions respect GCP regional boundaries. Cloudflare runs on its edge network (not GCP), and Claude SDK state is wherever you host your database."
    }
  ]}
/>

---

## Deployment topology

Where your agent runs determines latency, cost, and operational complexity.

| | **GEAP** | **Claude SDK** | **Cloudflare Agents** |
|---|---|---|---|
| **Where it runs** | GCP regions (us-central1, europe-west4, etc.) | Wherever you deploy | Cloudflare edge (300+ PoPs globally) |
| **Cold start** | Sub-second (pre-warmed) | Depends on your infra | Sub-millisecond |
| **Long-running** | Yes — multi-day workflows via Agent Runtime | Yes — depends on your infra | Yes — Durable Objects persist indefinitely |
| **WebSocket** | Via bidirectional streaming API | Manual implementation | Native, built into Durable Objects |
| **Scheduling** | Via Agent Simulation / GCP Cloud Scheduler | Your implementation | Native Durable Object alarms |
| **Multi-region** | Requires explicit configuration | You configure | Automatic global distribution |

Cloudflare wins on global latency and simplicity for real-time use cases. GEAP wins on compliance features and deep GCP ecosystem integration. Claude SDK wins on portability — you can run it on any cloud, on-premises, or in a hybrid setup.

---

## Model flexibility

| | **GEAP** | **Claude SDK** | **Cloudflare Agents** |
|---|---|---|---|
| **Models available** | 200+ (Gemini, Claude, Gemma, open models) | Claude family only (without manual wiring) | Model-agnostic (bring any API) |
| **Best reasoning model** | Gemini 3.1 Pro (with GEAP integration) | Claude Opus 4.7 | Depends on what you wire |
| **Multi-model agents** | Yes — different sub-agents can use different models | Requires OpenRouter or manual API calls | Yes — each agent call can target a different provider |
| **Platform-optimised model** | Gemini (tightest integration) | Claude (native) | None (bring your own) |

A nuance worth naming: GEAP lists 200+ models including Claude, but features like Agent Optimizer and Memory Bank distillation are designed assuming Gemini. You can run Claude Opus on GEAP infrastructure, but you are paying GCP prices to call Anthropic's API and losing some platform-level features in the process. If you want Anthropic's models, the Claude SDK is a more natural fit.

<Callout type="warning">
**The 200-model promise has a catch.** GEAP's model diversity is real for inference. But the Govern and Optimize features — Agent Anomaly Detection, Agent Optimizer, Memory Bank distillation — are designed around Gemini's capabilities and output format. If you route through Claude or an open model, test these features explicitly before relying on them in production.
</Callout>

---

## Lock-in surface area

This is the most important section for anyone building a production system. Lock-in is not binary — it is a spectrum. The question is not "can I leave?" but "how much does it cost to leave?"

### GEAP lock-in surface

High. The ADK is Apache 2.0 and portable. But:
- **Memory Bank**: proprietary GCP service, no export API at launch
- **Agent Registry**: your tool and agent catalogue lives in GCP
- **Agent Gateway**: traffic routing, rate limiting, and Model Armor are GCP-native
- **Agent Identity**: cryptographic IDs are GCP-issued; audit trails are in Cloud Audit Logs
- **Agent Runtime**: the execution environment is GCP-managed

If you leave GCP, you take your ADK code and rebuild every platform service. This is not unprecedented — it is the same trade-off you make with AWS Lambda (portable code, locked runtime) — but you should price it in.

**Mitigation**: Keep your business logic in ADK tools, not in platform-specific configurations. Avoid Memory Bank for any data you expect to migrate. Use agent instructions rather than Gateway rules for routing logic where possible.

### Claude Agent SDK lock-in surface

Low. The SDK calls the Anthropic API. Your agent logic is plain Python. Your state is in your own database. To leave:
- Point your API calls at a different provider (or use a gateway like LiteLLM to abstract the provider)
- Your tool code, conversation logic, and state management are unchanged

The only hard dependency is model compatibility — prompts tuned for Claude Opus may need adjustment for Gemini or GPT-4o. But the code itself is portable.

### Cloudflare Agents lock-in surface

Medium. The TypeScript SDK and `@callable()` pattern are open-source. But Durable Objects are Cloudflare-proprietary:
- If you leave Cloudflare, you rewrite the state layer (Durable Objects → Postgres, Redis, or a managed database)
- Scheduling (Durable Object alarms) needs replacement
- WebSocket connection management (built into Durable Objects) needs replacement

The agent logic itself — the methods decorated with `@callable()` — is portable. The infrastructure contract is not.

---

## Decision framework: which platform for which workload

Use this framework when you are choosing a platform for a new agent workload.

### Choose GEAP when

1. **You are already on GCP** and your data is in BigQuery, Cloud SQL, or GCS. The integration story is compelling — your agents read your data without egress or cross-cloud plumbing.
2. **You need enterprise governance**. Agent Identity, Agent Anomaly Detection, and Security Command Center integration are production-ready out of the box. Building equivalent features with Claude SDK takes months.
3. **You are building a multi-agent system with 5+ agents**. Agent Registry, Agent Gateway, and the Govern pillar were designed for exactly this scale. Wrangling 10 agents with Claude SDK and a homegrown registry is painful.
4. **Your workload is long-running** (multi-day workflows, invoice processing pipelines, autonomous research tasks). Agent Runtime's multi-day session support is purpose-built for this.

### Choose Claude Agent SDK when

1. **Reasoning quality is the primary constraint**. For complex multi-step tasks where accuracy matters more than speed, Claude Opus 4.7 is the strongest available model. If your agent needs to reason through ambiguous legal contracts, financial statements, or complex code, Claude SDK gives you direct access.
2. **You need to avoid vendor lock-in**. If there is any possibility you will need to move infrastructure (M&A, cloud cost negotiation, regulatory requirement), Claude SDK's portability is worth the engineering investment in a self-managed state layer.
3. **Your stack is heterogeneous**. Running on AWS with a team that knows Postgres and Redis? Claude SDK fits without requiring GCP knowledge.
4. **You need model comparisons**. Building an eval harness where you test Claude vs GPT vs Gemini on the same task? Claude SDK is one implementation; swapping models via LiteLLM or OpenRouter is straightforward.

### Choose Cloudflare Agents when

1. **Latency is the primary constraint**. Customer-facing chat agents where every millisecond matters, real-time WebSocket applications, or interactive voice interfaces. Cloudflare's edge delivers sub-millisecond cold starts that no regional cloud can match.
2. **Your app is already on Cloudflare**. If you are using Cloudflare Pages, Workers, or D1, Agents slots in natively. The Durable Object model is consistent with your existing Workers patterns.
3. **You are building in TypeScript** and want to avoid Python. Cloudflare Agents is TypeScript-first. If your team is JavaScript/TypeScript-native, the ergonomics are significantly better than ADK.
4. **You want simple, co-located state**. For agents where state is relatively simple (user preferences, conversation history, counters), `this.setState()` on a Durable Object is the simplest possible implementation — no database connection, no ORM, no schema migration.

<RunPromptCell
  model="claude-sonnet-4-6"
  tools={[]}
  prompt="I'm building a compliance monitoring agent for a fintech company. It needs to: flag unusual transactions, retain 90 days of alert history per user, run continuously on GCP (we're all-in on GCP), and produce audit logs for regulators. Which platform — GEAP, Claude SDK, or Cloudflare Agents — is the right fit, and why?"
  expectedOutput={`**Recommendation: GEAP**

This workload is a strong GEAP match for four reasons:

1. **You're already on GCP**: Data and compute stay in one cloud, no egress costs or cross-cloud IAM complexity.

2. **Compliance is table stakes**: Agent Identity gives you cryptographic audit trails per agent invocation. Security Command Center integration means your regulators can audit agent activity through tools they already know. Building equivalent compliance infrastructure on Claude SDK would take months.

3. **Anomaly detection is built in**: Agent Anomaly Detection uses statistical models + LLM-as-judge to flag unusual agent reasoning — which maps naturally onto your unusual-transaction detection use case.

4. **90-day alert history**: Memory Bank and Agent Sessions handle cross-session retention within GCP's data residency guarantees. Your 90-day window is a configuration, not a database schema you build.

**What you'd lose**: If you ever leave GCP, the audit trail and anomaly detection live in GCP services. Build your GEAP tool logic to be portable (pure Python functions with no GCP API calls inside them) and you mitigate this risk significantly.

**Claude SDK would apply if** reasoning quality on ambiguous transaction patterns were the primary constraint — Claude Opus 4.7 may outperform Gemini 3.1 Pro on nuanced edge cases. You could use both: GEAP for orchestration, governance, and state, with a Claude Opus sub-agent for the high-stakes flagging decisions.`}
/>

---

## The hybrid approach

Nothing in these three platforms is mutually exclusive. The most sophisticated production setups mix them:

- **GEAP orchestration + Claude sub-agents**: Use Agent Registry and Agent Gateway for governance, but route specific high-stakes decisions through a Claude Opus sub-agent via GEAP's Anthropic integration
- **Cloudflare edge + GEAP backend**: Real-time WebSocket connection via Cloudflare Agents for <50ms user-facing latency, with heavy processing delegated to GEAP Agent Runtime via an async queue
- **Claude SDK + Cloudflare state**: Use Claude for reasoning, Cloudflare Durable Objects as a simple, co-located state store, deploy on a VPS or Lambda

The lock-in analysis applies to each layer independently. You can use GEAP's agent governance while keeping your raw data in your own database — you just cannot use Memory Bank for that data.

<KnowledgeCheck
  questions={[
    {
      question: "A startup is building a real-time coding assistant that runs inside a VS Code extension. The agent needs to respond within 200ms, maintain per-user context (active file, recent edits), and support TypeScript. Which platform is the best primary fit?",
      answers: [
        "GEAP — because it has the most comprehensive model access",
        "Claude Agent SDK — because Claude Opus 4.7 has the best code reasoning",
        "Cloudflare Agents — because sub-millisecond edge latency and TypeScript-native Durable Objects match all three constraints",
        "All three are equally suitable"
      ],
      correct: 2,
      explanation: "Sub-200ms response time favors Cloudflare's edge. Per-user context fits naturally into Durable Object state. TypeScript-native is Cloudflare's strength. GEAP would add unnecessary latency for this real-time use case; Claude SDK lacks managed state and edge deployment."
    },
    {
      question: "Which GEAP feature has no direct equivalent in either Claude Agent SDK or Cloudflare Agents?",
      answers: [
        "Tool calling",
        "Multi-agent orchestration",
        "Agent Identity (cryptographic per-agent audit ID)",
        "Long-running workflows"
      ],
      correct: 2,
      explanation: "Tool calling and multi-agent orchestration exist in all three platforms. Long-running workflows are supported by all three (Durable Objects persist indefinitely; Claude SDK runs on your infra). Agent Identity — a cryptographic ID tied to every agent invocation with auditable trails — is a GEAP-specific Govern feature with no built-in equivalent elsewhere."
    },
    {
      question: "You are migrating an agent from GEAP to Claude Agent SDK. Which GEAP component requires the most migration engineering?",
      answers: [
        "ADK tool functions",
        "The agent instruction (system prompt)",
        "Memory Bank (cross-session long-term memory)",
        "The model selection (gemini-flash-latest)"
      ],
      correct: 2,
      explanation: "ADK tool functions are plain Python — copy them. The instruction is text — copy it. Model selection is a configuration change. Memory Bank is a proprietary managed service with no export API at launch; you must rebuild the long-term memory layer from scratch using a vector DB or similar."
    }
  ]}
/>

---

## Hands-on exercise: Map the budget tracker to three platforms

**Goal**: Understand what changes and what stays the same when you move an agent across platforms — without writing code.

**Steps**:

Take the budget tracker agent from Chapter 2 (the agent with `log_expense`, `get_expense_summary`, and session state). For each of the three platforms, answer these questions in writing:

**GEAP (you already built this)**:
1. Where does session state live?
2. How would you implement long-term memory of the user's monthly spending patterns?
3. Which Govern feature would you enable first in production, and why?

**Claude Agent SDK**:
1. What database/service would you use for session state? (Be specific: Postgres, Redis, DynamoDB, etc.)
2. How would you implement long-term memory? (Describe the retrieval mechanism)
3. What changes in the tool function signatures when moving from ADK to the Anthropic SDK?

**Cloudflare Agents**:
1. Draw the `BudgetAgent` class structure (TypeScript, using `this.setState()`). What fields does the state object have?
2. How would you expose the `logExpense` and `getSummary` methods? (Hint: `@callable()`)
3. What is the state isolation risk when the same user connects from two different Cloudflare edge locations?

**Success criteria**: A written comparison that correctly identifies: (a) the state management approach for each platform, (b) one genuine trade-off for each, and (c) which platform you would choose for your specific use case and why.

---

## What's next

You have completed the Gemini Enterprise Agent Platform hands-on tour. The logical next step is the capstone: a two-agent invoice-processing pipeline that ties together everything from Chapters 1-4. Full capstone specification is in the [[gemini-enterprise-agent-platform-hands-on-tour/outline]].

If you are evaluating other agent platforms, see also:
- [[course/claude-tool-use-from-zero]] for a deep dive on Claude's tool-use patterns
- [[course/cloudflare-agents-edge-patterns]] for Durable Objects and edge agent architecture

---

## References

[1] Google Cloud Blog. "Introducing Gemini Enterprise Agent Platform." 23 April 2026. — https://cloud.google.com/blog/products/ai-machine-learning/introducing-gemini-enterprise-agent-platform · retrieved 2026-04-30

[2] Google Agent Development Kit. Official documentation. — https://adk.dev/ · retrieved 2026-04-30

[3] Anthropic. Claude platform API reference. — https://claude.com/platform/api · retrieved 2026-04-30

[4] Cloudflare. Cloudflare Agents documentation. — https://developers.cloudflare.com/agents/ · retrieved 2026-04-30

[5] Anthropic. "Agents and Tools." Anthropic Documentation. — https://docs.anthropic.com/en/docs/agents-and-tools · retrieved 2026-04-30
