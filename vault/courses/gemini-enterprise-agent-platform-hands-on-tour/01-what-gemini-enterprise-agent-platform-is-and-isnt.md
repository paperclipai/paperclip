---
chapter_num: 1
title: "What Gemini Enterprise Agent Platform Actually Is (and Isn't)"
course_slug: gemini-enterprise-agent-platform-hands-on-tour
prerequisites_chapters: []
duration_min: 40
reading_time_min: 40
date: 2026-04-30
status: draft-for-review
author: "Koenig AI Academy"
agent_drafted_by: course-author
content_type: course-chapter
ticket: KOE-33
vendor_tag: google
learning_objectives:
  - "Describe the four pillars (Build / Scale / Govern / Optimize) and name two concrete features under each"
  - "Distinguish GEAP from Vertex AI Agent Builder, Dialogflow CX, and Model Garden"
  - "Identify three things GEAP explicitly does NOT do"
  - "Read a GEAP architecture diagram and label key components"
sources:
  - https://cloud.google.com/blog/products/ai-machine-learning/introducing-gemini-enterprise-agent-platform
  - https://adk.dev/
  - https://cloud.google.com/vertex-ai/docs
  - https://developers.cloudflare.com/agents/
  - https://docs.anthropic.com/en/docs/agents-and-tools
---

# What Gemini Enterprise Agent Platform Actually Is (and Isn't)

Google's **Gemini Enterprise Agent Platform** (GEAP), which reached general availability on 23 April 2026, is not a new product. It is a consolidation: every AI capability Google has shipped over the past four years — Vertex AI, Model Garden, Agent Builder, Dialogflow CX — now lives under one brand and one API surface. [1] For builders, understanding what that means in practice separates the people who benefit from the platform from those who spend three months wiring together services that already talk to each other.

## Key facts

1. GA date: 23 April 2026
2. Replaces and absorbs: Vertex AI Agent Builder, Model Garden (as a sub-surface), Dialogflow CX (legacy path)
3. Architecture: four pillars — Build, Scale, Govern, Optimize
4. Model access: 200+ models including Gemini 3.1 Pro/Flash, Gemma 4, Anthropic Claude (Opus/Sonnet/Haiku), and third-party open models
5. Entry points: Agent Studio (low-code visual), ADK — Agent Development Kit (code-first Python/TypeScript)
6. State primitives: Agent Sessions (conversation-scoped) + Memory Bank (long-term cross-session)
7. Security primitives: Agent Identity (cryptographic ID per agent), Agent Gateway (unified traffic control), Agent Anomaly Detection
8. Strategic signal: All future Vertex AI roadmap ships exclusively through GEAP — standalone Vertex services get no new features [1]

---

## The consolidation nobody saw coming

When Google announced GEAP, industry coverage focused on the new features: sub-agent networks, Memory Bank, Agent Identity. The buried lede was the strategic declaration at the end of the announcement: **"All Vertex AI services and roadmap evolutions will be delivered exclusively through Agent Platform going forward, rather than as standalone services."** [1]

That is a major commitment. It means if you are using Vertex AI Pipelines, Vertex AI Evaluation, or any other standalone Vertex service, your upgrade path is now through GEAP. Google is betting that agent-orchestration is the right abstraction for the next era of enterprise AI — not individual model calls, not standalone pipelines.

Whether that bet pays off for you depends on your use case. This chapter explains the architecture so you can make that judgment with clear eyes.

---

## The four pillars

GEAP is organized into four operational domains. Every feature belongs to one of them. Knowing which pillar a feature belongs to tells you when in your development lifecycle you need it.

### Pillar 1: Build

Build is where you create agents. There are two entry points:

**Agent Studio** is a low-code, visual interface. You drag components, define tools from a catalogue, set an instruction prompt, and get a deployable agent without writing code. Studio is fast for prototyping and useful for non-engineers who need to configure agents within guardrails set by an engineering team.

**Agent Development Kit (ADK)** is the code-first environment. It is a Python library (with TypeScript support) where agents are Python objects, tools are Python functions, and orchestration is expressed in code. ADK is where the rest of this course lives.

Within Build, two other features matter:

- **Agent Garden**: pre-built agent templates for common enterprise tasks (code modernization, invoice processing, financial analysis). Think of these as starting points, not production systems — they require customization.
- **Workspaces**: sandboxed environments where agents can execute bash commands and manage files. This is GEAP's answer to Code Interpreter: instead of running untrusted code on your infrastructure, agents get a hardened sandbox.

<Callout type="info">
**Low-code vs code-first**: The two entry points are not mutually exclusive. Agent Studio can export an agent definition that ADK can consume. If you prototype in Studio and then need programmatic control, you can migrate without starting over.
</Callout>

### Pillar 2: Scale

Scale is where your agents move from working to production-grade. The key features:

**Agent Runtime** is GEAP's managed execution environment. It promises sub-second cold starts and provisions agents in seconds. Crucially, Agent Runtime does not require code changes — an ADK agent that runs locally deploys to Runtime with a configuration file, not a rewrite.

**Agent Sessions** provides conversation-scoped state management. Each session has a unique ID that you can map to an external record (a database row, a CRM contact). State stored in a session is available to any agent invocation that carries that session ID.

**Memory Bank** adds a layer above sessions: long-term, cross-session memory. Where a session holds raw conversation history, Memory Bank distills it — it uses a model to generate "Memory Profiles" (structured summaries) and retrieves them at low latency when a new session starts. The practical effect is that an agent that spoke to a user three months ago can recall relevant facts without loading three months of transcript.

**Agent-to-agent orchestration** supports both deterministic patterns (you define the routing logic) and generative patterns (the orchestrator model decides which sub-agent to invoke). This distinction matters more than it seems — we cover it in [[gemini-enterprise-agent-platform-hands-on-tour/03-multi-agent-orchestration-with-vertex]].

### Pillar 3: Govern

Govern is GEAP's answer to the question "how do I run 50 agents in production without losing control of them?"

**Agent Identity** gives every deployed agent a unique cryptographic ID. Every action the agent takes is associated with that ID — tool calls, memory reads, external API calls. This creates an auditable trail you can query when something goes wrong.

**Agent Registry** is a central catalogue of approved tools, agents, and capabilities. Instead of every team defining their own version of a "get customer order" tool, Registry enforces a single canonical definition. Agents discover available tools through Registry rather than hardcoded imports.

**Agent Gateway** is the traffic layer. All agent-to-external and agent-to-agent traffic routes through Gateway, which applies consistent security policies, rate limits, and Model Armor protections. Model Armor is Google's term for prompt injection and data leakage defenses applied at the network layer — not inside the model.

**Agent Security Dashboard** integrates with Security Command Center for vulnerability scanning and asset discovery. If an agent starts making requests to unexpected IP ranges, this is where you see it.

### Pillar 4: Optimize

Optimize is where you measure and improve agents after they are running.

**Agent Simulation** lets you test agents against synthetic user interactions and virtualized tools before deploying changes. This is the equivalent of a staging environment specifically designed for agent behavior — tools return canned responses so you can test routing logic without hitting real APIs.

**Agent Evaluation** provides continuous scoring. Multi-turn autoraters score agent responses against rubrics you define, and turnkey dashboards track those scores over time. This is important: agent quality degrades as your tools change and your user base grows. Without evaluation, you find out by reading support tickets.

**Agent Observability** provides visual tracing of agent reasoning. Every tool call, every model invocation, every memory read gets a trace entry. You can walk through what happened step-by-step — which matters when an agent made four tool calls and returned the wrong answer.

**Agent Optimizer** closes the loop: it clusters observed failures and suggests system instruction refinements. It is not autonomous (it suggests, not applies), but it reduces the manual work of reading failure logs to write better prompts.

---

## What GEAP is not

The four pillars are comprehensive enough that it is easy to assume GEAP is everything. Three things it is not:

**It is not model-agnostic in practice.** GEAP supports 200+ models including Claude and open models. But the tightest integrations — Memory Bank, Agent Runtime telemetry, Agent Optimizer — are designed around Gemini. If you route all your traffic through Claude on GEAP, you are using GCP infrastructure with Anthropic's model, which works, but you lose some platform-level features that assume Gemini's specific capabilities.

**It is not open-source.** The ADK is open-source (Apache 2.0). The runtime, Memory Bank, Agent Gateway, and Govern features are fully proprietary GCP services. If you need to run your agent stack on-premises or on another cloud, you can use ADK locally, but you cannot replicate the platform layer.

**It is not Dialogflow CX rebranded.** Dialogflow CX was a flow-based, deterministic dialogue manager. GEAP's agents reason with LLMs and make probabilistic decisions. Existing Dialogflow CX flows can be migrated, but the mental model is fundamentally different. If you build a GEAP agent expecting it to follow a defined script reliably, you will be surprised.

<Callout type="warning">
**Lock-in surface area**: Using Agent Runtime, Memory Bank, and Agent Registry together creates deep GCP lock-in. Your agent logic is in ADK (portable), but your state, tool registry, and identity system are GCP-proprietary. Plan for this before you commit. [[gemini-enterprise-agent-platform-hands-on-tour/04-comparing-to-claude-agent-sdk-and-cloudflare-agents]] compares exit paths across GEAP, Claude Agent SDK, and Cloudflare Agents.
</Callout>

---

## How the components connect

Here is the component map for a typical customer-support agent on GEAP. Read this as a data-flow diagram, left to right:

```
User request
    │
    ▼
Agent Gateway  ◄── Model Armor (prompt injection filter)
    │
    ▼
Agent Runtime  ── resolves Agent Identity (cryptographic ID)
    │
    ├── loads Memory Bank profile (cross-session context)
    │
    ├── loads Session state (current conversation)
    │
    ▼
 Agent (ADK)
    │
    ├── Tool call A (via Agent Registry, approved tool)
    ├── Tool call B
    │
    ▼
Agent Observability  ── traces every step
    │
    ▼
Response → User
    │
    ▼
Agent Evaluation  ── scores response, stores metric
    │
    ▼
Agent Optimizer  ── clusters failures, suggests instruction updates
```

Every box in this diagram is a managed GCP service. The only code you write is the Agent itself and the tool implementations. That is the core value proposition — and the core lock-in.

<KnowledgeCheck
  questions={[
    {
      question: "Which GEAP pillar contains Memory Bank and Agent Sessions?",
      answers: [
        "Build",
        "Scale",
        "Govern",
        "Optimize"
      ],
      correct: 1,
      explanation: "Memory Bank and Agent Sessions are Scale features — they exist to make agents production-grade by providing state continuity across restarts and long-term memory across session boundaries."
    },
    {
      question: "An engineering team at a fintech company needs to ensure every tool call an agent makes is tied to a named, auditable identity for compliance reasons. Which GEAP feature addresses this?",
      answers: [
        "Agent Registry",
        "Agent Simulation",
        "Agent Identity",
        "Agent Optimizer"
      ],
      correct: 2,
      explanation: "Agent Identity assigns a unique cryptographic ID to every deployed agent. All actions — tool calls, memory reads, API calls — are associated with that ID, creating the auditable trail compliance requires."
    },
    {
      question: "Which statement about GEAP's model access is most accurate?",
      answers: [
        "GEAP only supports Gemini models",
        "GEAP supports 200+ models including Claude, but tightest platform integrations are Gemini-optimised",
        "GEAP supports all models equally with no integration differences",
        "GEAP requires you to use Gemini as the orchestrator, with other models only as sub-agents"
      ],
      correct: 1,
      explanation: "GEAP supports Claude and open models, but features like Agent Optimizer and some Memory Bank integrations are designed around Gemini's capabilities. You can use other models, but with reduced platform integration."
    }
  ]}
/>

---

## The contrarian view: is consolidation actually good?

GEAP's consolidation narrative is compelling, but it carries a real cost: **surface area**. When Vertex AI was a collection of loosely coupled services, a team could adopt Vertex Model Garden without adopting Vertex Evaluation. Now that everything is GEAP, the conceptual overhead of the platform is always in scope.

For a solo developer building a weekend project, GEAP is overkill. The four-pillar architecture is enterprise governance applied to a problem that might be solved with a single API call and a Postgres table. The marketing targets "enterprise scale" — and if your workload is not that, the platform actively gets in your way.

The more honest framing: GEAP is the right platform when you need **at least two of the four pillars** in production. If you need Build + Govern (multiple agents with compliance requirements), GEAP is compelling. If you only need Build, you are paying for three pillars you do not use. We make this trade-off concrete in [[gemini-enterprise-agent-platform-hands-on-tour/04-comparing-to-claude-agent-sdk-and-cloudflare-agents]].

---

## Hands-on exercise

**Draw the GEAP component map for your use case.**

Pick a real (or plausible) agent you want to build. On paper or in a diagramming tool:

1. Draw the data flow from user request to response.
2. For each GEAP component you would use, label which pillar it belongs to.
3. Mark any component you would *not* use and write one sentence explaining why.
4. Identify: does your use case require two or more pillars? If not, write a note questioning whether GEAP is the right platform.

**Success criteria**: A diagram with at least 4 GEAP components labelled by pillar, and a written answer to the "two pillars?" question.

---

## What's next

Chapter 2 gets hands-on: you will install ADK, define a Python function as a tool, wire it into an Agent, and add session and Memory Bank persistence. By the end you will have an agent that remembers your last session — even after a process restart.

See [[gemini-enterprise-agent-platform-hands-on-tour/02-hello-world-agent-tool-state-persistence]] to continue.

---

## References

[1] Google Cloud Blog. "Introducing Gemini Enterprise Agent Platform." 23 April 2026. https://cloud.google.com/blog/products/ai-machine-learning/introducing-gemini-enterprise-agent-platform · retrieved 2026-04-30

[2] Google Agent Development Kit. Official documentation. https://adk.dev/ · retrieved 2026-04-30

[3] Google Cloud. Vertex AI documentation. https://cloud.google.com/vertex-ai/docs · retrieved 2026-04-30

[4] Cloudflare. Cloudflare Agents documentation. https://developers.cloudflare.com/agents/ · retrieved 2026-04-30

[5] Anthropic. Building with Claude — Agents and tools. https://docs.anthropic.com/en/docs/agents-and-tools · retrieved 2026-04-30
