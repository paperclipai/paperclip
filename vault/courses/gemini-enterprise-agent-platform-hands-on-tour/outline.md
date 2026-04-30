---
course_slug: gemini-enterprise-agent-platform-hands-on-tour
title: "Gemini Enterprise Agent Platform: A Hands-On Tour — from Hello World to Production"
status: outline-draft-for-review
author: course-author
level: Builder
vendor_tag: google
target_audience: "Developers who have shipped at least one LLM demo and want to run real agents on GCP — comfortable with Python, familiar with REST APIs, may have used OpenAI or Anthropic APIs but new to Vertex."
prerequisites:
  - "Python 3.10+ and pip"
  - "A Google Cloud project with billing enabled"
  - "Familiarity with at least one LLM API (OpenAI, Anthropic, or Gemini)"
  - "Basic understanding of async Python (async/await)"
learning_outcomes:
  - "Build and locally run a working ADK agent with at least one tool"
  - "Persist agent state across sessions using Agent Sessions and Memory Bank"
  - "Wire together two or more agents in a supervisor/worker orchestration pattern"
  - "Critically compare GEAP to Claude Agent SDK and Cloudflare Agents and choose the right platform for a given workload"
total_duration_min: 210
chapter_count: 4
capstone_project_min: 45
---

# Gemini Enterprise Agent Platform: A Hands-On Tour

## Why this course

Google's Gemini Enterprise Agent Platform (GEAP), which went GA on 23 April 2026, is the most consequential rebranding in Google Cloud's AI history. Every Vertex AI service — model serving, fine-tuning, pipelines, evaluation — now lives inside one unified surface. For builders, that is either a superpower or a lock-in trap, depending on how you wire it.

This course is for the developer who has a working LLM demo and needs to know if GEAP is the right home for their production agent. We skip the marketing slides and go straight to code: ADK installs, real tool definitions, session persistence, multi-agent graphs, and a frank comparison with the two most credible alternatives (Claude Agent SDK and Cloudflare Agents).

By the end of Chapter 4 you will have a working multi-agent system deployed to Agent Runtime — and an honest opinion about when to use it.

## Course outline

### Chapter 1: What Gemini Enterprise Agent Platform actually is (and isn't)
- **Duration**: 40 min
- **Prerequisites**: None (course intro)
- **Learning objectives**:
  - Describe the four pillars (Build / Scale / Govern / Optimize) and name two concrete features under each
  - Distinguish GEAP from its predecessors: Vertex AI Agent Builder, Dialogflow CX, and Model Garden
  - Identify three things GEAP explicitly does NOT do (single-model dependency, open-source guarantees, free tier for enterprises)
  - Read a GEAP architecture diagram and label key components
- **Key concepts**: Agent Runtime, Memory Bank, Agent Gateway, ADK vs Agent Studio, Vertex AI consolidation, Agent Sessions, cryptographic Agent Identity
- **Hands-on**: Draw (on paper or a whiteboard tool) the GEAP component map for a customer-support agent. Identify which pillar each component belongs to.

---

### Chapter 2: Hello-world — agent + 1 tool + state persistence
- **Duration**: 55 min
- **Prerequisites**: Chapter 1, GCP project with billing
- **Learning objectives**:
  - Install `google-adk` and run an agent locally in under 10 minutes
  - Define a Python function as a tool and attach it to an agent
  - Explain the difference between in-session state (`state`) and long-term memory (`Memory Bank`)
  - Persist a conversation across process restarts using Agent Sessions
- **Key concepts**: `Agent` class, tool decorator pattern, `Session`, `MemoryBank`, `InMemoryRunner` vs `VertexAiSessionService`, cold-start latency
- **Hands-on**: Build a "budget tracker" agent — a tool that logs expenses and a Memory Bank profile that summarises them across sessions.

---

### Chapter 3: Multi-agent orchestration with Vertex
- **Duration**: 60 min
- **Prerequisites**: Chapter 2
- **Learning objectives**:
  - Explain the difference between deterministic and generative orchestration patterns in GEAP
  - Wire a supervisor agent that delegates to two specialist sub-agents
  - Use Agent Registry to discover and call a registered agent by name
  - Read an Agent Observability trace to debug a failed agent handoff
- **Key concepts**: sub-agent networks, graph-based orchestration, `AgentRegistry`, `AgentGateway`, sequential vs parallel routing, transfer_to_agent, Agent Anomaly Detection
- **Hands-on**: Build a two-agent research pipeline: a "Planner" agent that decomposes a question and a "Retriever" sub-agent that answers each sub-question. Wire them with Agent Registry and view the trace in Agent Observability.

---

### Chapter 4: Comparing to Claude Agent SDK + Cloudflare Agents
- **Duration**: 55 min
- **Prerequisites**: Chapters 1–3 (hands-on experience with GEAP)
- **Learning objectives**:
  - Contrast GEAP state management (Memory Bank + Sessions) with Claude Agent SDK and Cloudflare Durable Objects
  - Identify the deployment topology differences: GCP-regional vs global-edge vs bring-your-own-infra
  - Name three workloads where GEAP wins and three where a lighter alternative is preferable
  - Apply a vendor-selection framework to a real-world scenario
- **Key concepts**: Durable Objects, Cloudflare `@callable()`, Claude managed agents (Anthropic API), vendor lock-in, egress costs, cold-start latency, MCP compatibility
- **Hands-on**: Map the budget-tracker agent from Chapter 2 onto the other two platforms (design only, no code required). Identify what changes and what stays the same.

---

## Capstone project

**Build a two-agent invoice-processing pipeline on GEAP.**

Deliverable:
- An ADK codebase with: an Orchestrator agent, an Extractor sub-agent (mocks PDF parsing), and a Validator sub-agent (checks totals against a rules file)
- Both agents use Agent Sessions for state continuity
- A Memory Bank profile that retains the last five invoice summaries
- A local run that processes three test invoices end-to-end
- A README explaining which GEAP Govern features you would enable in production and why

Verification criteria:
- `adk run` processes all three test invoices without crashing
- Memory Bank summary is visible after session restart
- README names Agent Gateway, Agent Identity, and at least one Govern feature with a rationale

Time: 45 min

---

## Why this beats alternatives

Most GEAP tutorials are feature lists. This course puts you in the seat of a builder who already has something working and needs to decide whether to go deeper into GCP's ecosystem. Every chapter is opinionated — we tell you what the marketing misses and where the real traps are.
