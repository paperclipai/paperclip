---
course_slug: gemini-enterprise-agents
title: "Build Production AI Agents with Gemini Enterprise Agent Platform"
status: outline-draft-for-review
author: course-author
level: Builder
vendor_tag: google
target_audience: "GCP architects, enterprise AI/ML engineers, DevOps leads evaluating agent infrastructure, and platform engineers building internal AI tooling at mid-to-large enterprises who must defend production agent deployments to a CISO."
prerequisites:
  - "Python 3.10+ and familiarity with async/await"
  - "A Google Cloud project with billing enabled"
  - "Familiarity with at least one LLM API (Gemini, OpenAI, or Anthropic)"
  - "Basic understanding of IAM, VPC networking, and GCP project structure"
  - "Comfort reading architecture diagrams and API reference docs"
learning_outcomes:
  - "Design and deploy a single Gemini-powered agent on Agent Runtime with tools, sessions, and Memory Bank"
  - "Architect multi-agent orchestration patterns (supervisor/worker, sequential pipeline, A2A) using Agent Registry"
  - "Configure Agent Gateway, Agent Identity, and Model Armor for a CISO-defensible deployment"
  - "Implement production observability (traces, logs, metrics, topology) and automated evaluation pipelines"
  - "Operate a production agent system with SLA targets, cost controls, and incident response runbooks"
total_duration_min: 300
chapter_count: 7
capstone_project_min: 60
---

# Build Production AI Agents with Gemini Enterprise Agent Platform

## Why this course

Google's Gemini Enterprise Agent Platform (GEAP), GA since 23 April 2026, is the first cloud-native agent runtime with DevSecOps baked in. Every Vertex AI service now lives under one unified surface — model serving, fine-tuning, pipelines, evaluation, and the new agent primitives (Runtime, Memory Bank, Agent Gateway, Agent Identity).

Most agent tutorials end at "hello world with a tool." This course starts where they stop. It is for the engineer who must defend a production agent deployment to a CISO — not just ship a demo. Every chapter produces something you can show your security team, your SRE on-call, or your finance department.

By the end of Chapter 7 you will have a fully deployed multi-agent system behind Agent Gateway, with IAM policies, Model Armor, structured observability, and an evaluation pipeline — and the runbook to operate it.

**Merged 2026-05-01 with the former hands-on-tour course.** Per Vardaan's instruction, the two Gemini Enterprise courses (`gemini-enterprise-agent-platform-hands-on-tour` + this one) have been consolidated under this canonical slug. The 4 written chapter drafts from the hands-on-tour course are now in this directory as Ch1-Ch4 stubs and need to be **rewritten by course-author** to fit the production focus described in this outline (current chapter content is intro-level; this outline targets production/CISO-defensible). Ch5-Ch7 are net-new and need to be written from scratch. The hands-on-tour outline shell is archived at `vault/_dedupe-archive/2026-05-01/courses/gemini-enterprise-agent-platform-hands-on-tour/`.

**Action items for course-author (post-merge):**
- Rewrite Ch1 (currently "What GEAP is and isn't" — intro) to fit "The production agent landscape — why GEAP exists"
- Rewrite Ch2 (currently "Hello-world: tool, state, persistence") to fit "Single-agent setup — build, tool, persist"
- INSERT Ch3 (RAG and grounding) — net-new, no existing draft
- Rewrite Ch3 (currently "Multi-agent w/ Vertex") and renumber to Ch4 to fit "Multi-agent orchestration"
- Move Ch4 (currently "Comparing to Claude Agent SDK and Cloudflare Agents") to an Appendix or fold into Ch1 as a "what GEAP is not" section
- Write Ch5 (Enterprise security), Ch6 (Observability), Ch7 (Scale + cost)

## Course outline

### Chapter 1: The production agent landscape — why GEAP exists
- **Duration**: 35 min
- **Prerequisites**: None (course intro)
- **Learning objectives**:
  - Explain why stitching LangChain demos into microservices fails at enterprise scale (state sprawl, no identity, no audit trail)
  - Map GEAP's four pillars (Build / Scale / Govern / Optimize) to enterprise requirements: who in your org needs what
  - Identify the three things GEAP explicitly does NOT guarantee (multi-cloud portability, open-source model access, free-tier SLAs) and the architectural workarounds for each
  - Read a GEAP architecture diagram and annotate which pillar owns each component
- **Key concepts**: Agent Runtime, Memory Bank, Agent Gateway, Agent Identity, Agent Registry, Model Armor, ADK vs Agent Studio, the Vertex AI consolidation, enterprise SLA tiers
- **Hands-on**: Draw the GEAP component map for an enterprise HR-onboarding agent. Annotate which pillar owns each component, which IAM roles are needed, and where data flows cross VPC boundaries.

---

### Chapter 2: Single-agent setup — build, tool, and persist
- **Duration**: 50 min
- **Prerequisites**: Chapter 1, GCP project with billing, `gcloud` CLI installed
- **Learning objectives**:
  - Install `google-adk`, scaffold an agent, and run it locally in under 15 minutes
  - Define Python functions as tools with proper type hints and docstrings that ADK can introspect
  - Distinguish in-session state (`Session`) from long-term memory (`Memory Bank`) and explain when to use each
  - Deploy the agent to Agent Runtime and invoke it via the managed API endpoint
- **Key concepts**: `Agent` class, `@tool` decorator, `InMemoryRunner` vs `VertexAiSessionService`, `MemoryBank`, Agent Runtime deployment, cold-start behavior, tool annotations
- **Hands-on**: Build a "Policy Q&A" agent — a tool that queries a mock policy document store, a Session that tracks the conversation, and a Memory Bank profile that accumulates the user's department and access level across sessions. Deploy to Agent Runtime and verify via `curl`.

---

### Chapter 3: RAG and grounding — agents that know your enterprise data
- **Duration**: 45 min
- **Prerequisites**: Chapter 2
- **Learning objectives**:
  - Configure RAG Engine with your own corpus (PDF, HTML, Cloud Storage) and explain the ingestion pipeline
  - Distinguish the five grounding options (Google Search, Google Maps, RAG Engine, Agent Search, Elasticsearch) and select the right one for three enterprise scenarios
  - Set up Agent Platform Vector Search 2.0 as the backing vector store for RAG
  - Measure retrieval quality and diagnose hallucination with grounding metadata and citation scores
- **Key concepts**: RAG Engine, corpus ingestion, chunking and parsing strategies (Document AI, LLM parser), Vector Search 2.0 collections, grounding with Google Search, Agent Search, hybrid retrieval, reranking
- **Hands-on**: Ingest a set of 10 internal policy documents into a RAG corpus. Connect the Policy Q&A agent from Chapter 2 to the corpus. Run five test queries and compare responses with and without grounding. Identify at least one hallucination that grounding eliminates.

---

### Chapter 4: Multi-agent orchestration — from solo to ensemble
- **Duration**: 55 min
- **Prerequisites**: Chapter 3
- **Learning objectives**:
  - Implement three orchestration patterns: supervisor/worker, sequential pipeline, and Agent2Agent (A2A) inter-platform delegation
  - Register agents in Agent Registry and discover them by name and capability annotations
  - Wire agent handoffs with `transfer_to_agent` and debug failed handoffs using Agent Observability traces
  - Design a multi-agent system that avoids common anti-patterns: circular delegation, unconstrained fan-out, and shared mutable state
- **Key concepts**: sub-agent networks, graph-based orchestration, `AgentRegistry`, `transfer_to_agent`, Agent2Agent protocol, sequential vs parallel routing, agent anomaly detection, orchestration anti-patterns
- **Hands-on**: Build a three-agent invoice processing pipeline — an Orchestrator (supervisor), an Extractor sub-agent (mocks PDF parsing), and a Validator sub-agent (checks totals against rules). Register all three in Agent Registry. Process three test invoices end-to-end and view the trace in Agent Observability.

---

### Chapter 5: Enterprise security — CISO-defensible deployments
- **Duration**: 50 min
- **Prerequisites**: Chapter 4
- **Learning objectives**:
  - Configure Agent Identity (SPIFFE-formatted ID) per agent and assign IAM roles directly to the agent — no shared service accounts
  - Set up Agent Gateway as the single traffic enforcement point: intercept tool calls, enforce access control policies, and apply Model Armor inspection
  - Implement user-delegated OAuth 2.0 via Agent Identity Auth Manager so agents invoke tools on behalf of specific users with a clear audit trail
  - Write a security review checklist that a CISO can approve for a GEAP deployment
- **Key concepts**: Agent Identity (SPIFFE), Agent Gateway, Model Armor, Agent Identity Auth Manager, 2-legged and 3-legged OAuth, VPC-Service Controls, Customer-Managed Encryption Keys (CMEK), Application Design Center, audit logging, semantic governance policies
- **Hands-on**: Secure the invoice pipeline from Chapter 4 — assign Agent Identities to each sub-agent, configure Agent Gateway to enforce that the Extractor can only read from the designated Cloud Storage bucket, enable Model Armor on tool-call responses, and verify the IAM audit log captures agent actions.

---

### Chapter 6: Production observability and evaluation
- **Duration**: 50 min
- **Prerequisites**: Chapter 5
- **Learning objectives**:
  - Configure Cloud Observability (Trace, Logging, Monitoring, Topology) for deployed agents using OpenTelemetry
  - Read an agent trace to diagnose a failed tool call, identify the latency bottleneck, and calculate token cost per interaction
  - Set up an automated evaluation pipeline using Gen AI Evaluation Service: Auto SxS for online evaluation and offline evaluation with curated test sets
  - Configure quality alerts and Example Store for continuous improvement
- **Key concepts**: Cloud Trace, Cloud Logging, Cloud Monitoring, Topology view, OpenTelemetry, Gen AI Evaluation Service, Auto SxS, offline evaluation, online monitors, quality alerts, Example Store, failure cluster analysis
- **Hands-on**: Enable observability on the invoice pipeline. Inject a deliberate failure (misconfigured tool). Read the trace to identify the failure point. Run an offline evaluation with a 20-query test set. Configure a quality alert for latency > 5s. Verify the alert fires in the monitoring dashboard.

---

### Chapter 7: Operating at scale — SLAs, cost, and incident response
- **Duration**: 45 min
- **Prerequisites**: Chapter 6
- **Learning objectives**:
  - Define SLA targets (latency, availability, cost-per-transaction) for a production agent deployment and map them to GEAP's pricing model and quota system
  - Implement cost controls: model selection (Flash vs Pro), token budgeting, and caching strategies
  - Write an incident response runbook specific to agent failures: tool-timeout, model-overspend, Memory Bank corruption, Agent Gateway outage
  - Plan a rollback strategy for agent code changes using Agent Registry versioning and gradual traffic shifting
- **Key concepts**: SLA definition, GEAP pricing tiers, token budgeting, model selection strategy (Gemini Flash vs Pro), caching, Agent Registry versioning, traffic shifting, incident response runbooks, Memory Bank backup and recovery, Agent Gateway redundancy, Private Service Connect
- **Hands-on**: Write a production runbook for the invoice pipeline. Include: SLA targets with rationale, cost projection for 10K invoices/month, escalation matrix for three failure scenarios, and a rollback procedure for agent code updates. Test the rollback by deploying a deliberate regression and reverting via Agent Registry.

---

## Capstone project

**Deploy a production-grade multi-agent system for enterprise document processing.**

Deliverable:
- An ADK codebase with: a Supervisor agent, a Document Ingestion sub-agent (uses RAG Engine), a Compliance Checker sub-agent (uses grounding + rules), and a Notification sub-agent (sends alerts)
- All agents registered in Agent Registry with Agent Identities
- Agent Gateway configured with IAM policies and Model Armor
- RAG Engine corpus with at least 20 real documents ingested
- Cloud Observability enabled with traces, logs, and at least one quality alert
- An offline evaluation with a 30-query test set showing >80% accuracy
- A production runbook covering SLA targets, cost projections, incident response, and rollback procedures
- A CISO security review checklist completed for the deployment

Verification criteria:
- `adk deploy` succeeds and all four agents are reachable via Agent Runtime
- Agent Gateway blocks an unauthorized tool call (demonstrated in trace)
- Model Armor flags a sensitive-data leak in a tool response (demonstrated in audit log)
- Memory Bank retains user context across three separate sessions
- Offline evaluation achieves >80% accuracy on the test set
- Quality alert fires when latency exceeds the defined threshold
- Runbook is reviewable by a security team with no GEAP-specific knowledge

Time: 60 min

---

## How this course relates to our existing GEAP course

Our *Gemini Enterprise Agent Platform: A Hands-On Tour* (4 chapters) is an introductory course for developers evaluating GEAP against alternatives. It covers hello-world agents, basic tool use, multi-agent patterns, and a comparison with Claude Agent SDK and Cloudflare Agents.

**This course is not a duplicate.** It assumes the learner has decided to build on GEAP and needs to ship something production-grade. Chapters 3–7 (RAG, security, observability, evaluation, operations) have no overlap with the Tour course. Learners who completed the Tour will find Chapter 2 a useful refresher and can skip to Chapter 3.

---

## Why this beats alternatives

Most GEAP content stops at "deploy your first agent." No existing tutorial covers Agent Gateway configuration, Model Armor inspection, or Agent Identity IAM. No course teaches you how to write a CISO review checklist for an agent deployment. This course does — because the real bottleneck for enterprise agent adoption isn't the code, it's the security review.

---

## Sources

1. [Google Cloud Blog: Introducing Gemini Enterprise Agent Platform](https://cloud.google.com/blog/products/ai-machine-learning/introducing-gemini-enterprise-agent-platform)
2. [GEAP Agents Overview — Official Docs](https://docs.cloud.google.com/gemini-enterprise-agent-platform/agents/overview)
3. [Agent Studio Overview — Official Docs](https://docs.cloud.google.com/gemini-enterprise-agent-platform/agent-studio/overview)
4. [Agent Development Kit (ADK)](https://docs.cloud.google.com/gemini-enterprise-agent-platform/build/runtime/quickstart-adk)
5. [RAG Engine Overview — Official Docs](https://docs.cloud.google.com/gemini-enterprise-agent-platform/build/rag-engine/rag-overview)
6. [Agent Gateway Overview — Official Docs](https://docs.cloud.google.com/gemini-enterprise-agent-platform/govern/gateways/agent-gateway-overview)
7. [Agent Identity Overview — Official Docs](https://docs.cloud.google.com/gemini-enterprise-agent-platform/govern/agent-identity-overview)
8. [Cloud Observability for Agents — Official Docs](https://docs.cloud.google.com/gemini-enterprise-agent-platform/optimize/observability/overview)
9. [Gen AI Evaluation Service — Official Docs](https://docs.cloud.google.com/gemini-enterprise-agent-platform/optimize/evaluation/agent-evaluation)
10. [Google DeepMind: Measuring AGI Progress](https://blog.google/innovation-and-ai/models-and-research/google-deepmind/measuring-agi-cognitive-framework/)
11. [OpenAI on AWS — Competitive Context](https://openai.com/index/openai-on-aws/)
