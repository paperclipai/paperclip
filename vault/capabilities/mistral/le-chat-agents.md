---
name: "Le Chat Agents (Mistral)"
kind: agent-sdk
one_liner: "Le Chat Agents are Mistral's hosted agent runtime, accessible through the Le Chat consumer interface and the Mistral API, with built-in tool use, web browsing, code execution, and document understanding — Mistral's answer to OpenAI Custom GPTs and Anthropic Managed Agents, optimized for European data residency and Mistral Large 2 inference cost."
shipped: "2025-11-18"
status: ga
description: "Mistral's hosted agent runtime, available through Le Chat and the API."
primary_url: "https://mistral.ai/news/le-chat-enterprise/"
related_terms: [agent-harness, tool-use]
related_courses: []
related_blogs: []
sameAs: []
---

## What Le Chat Agents offer

Le Chat Agents bundle Mistral Large 2 (or smaller Mixtral variants for cost-sensitive deployments) with a managed agent loop, native tool calling (function-calling-compatible JSON Schema), web search, code execution in a sandboxed Python runtime, and document understanding (PDFs, Word, Excel).

The Enterprise tier (announced November 2025) adds SSO, on-prem deployment options for the agent runtime, audit logging, and EU data residency guarantees — a clear positioning play for European enterprises that prefer not to send data to US-hosted Anthropic / OpenAI / Google clouds.

## Comparison with frontier-vendor offerings

Le Chat Agents are functionally similar to Anthropic Managed Agents and OpenAI Assistants. The differentiators: (1) cost — Mistral Large 2 inference is roughly 30-50% cheaper than Claude Sonnet 4.6 or GPT-5.5 for similar tasks; (2) data residency — EU-only deployment options; (3) open-weights option — for sufficiently sensitive workloads, customers can run Mixtral and Codestral on-premise and connect to a Mistral-managed agent orchestration layer.

## Limitations

Mistral's models lag Claude / GPT-5.5 / Gemini 3.1 Pro on raw intelligence (especially multi-step reasoning and tool selection). For tasks where determinism matters more than cost, frontier vendors still win.
