---
name: "Gemini Enterprise Agent Platform (Vertex)"
kind: agent-sdk
one_liner: "The Gemini Enterprise Agent Platform, announced April 23, 2026 as a rebrand and consolidation of Vertex AI Agent Builder, is Google Cloud's production-grade agent runtime — providing Gemini-powered agents with state persistence, tool calling, multi-agent orchestration, observability, IAM-scoped access controls, and turnkey deployment to Google Cloud."
shipped: "2026-04-23"
status: ga
description: "Google Cloud's production agent runtime — formerly Vertex AI Agent Builder."
primary_url: "https://cloud.google.com/blog/products/ai-machine-learning/introducing-gemini-enterprise-agent-platform"
related_terms: [agent-harness, tool-use]
related_courses: [gemini-enterprise-agent-platform-hands-on-tour]
related_blogs: [gemini-enterprise-vertex-the-first-real-agent-platform]
sameAs: []
---

## What the rebrand consolidates

Vertex AI Agent Builder (the previous name) was perceived as a low-code wizard for building chat agents. The Gemini Enterprise Agent Platform rebrand reflects an expanded scope: it's now positioned as the canonical Google Cloud answer to Anthropic's Managed Agents and OpenAI's Assistants API, with first-class support for stateful multi-agent workflows, tool ecosystems, and deployment patterns.

## What's actually different from competing offerings

Three differentiators specific to Vertex's agent platform: (1) deep IAM integration — agent permissions are first-class Google Cloud IAM principals, so agent access to BigQuery / Cloud Storage / Secret Manager flows through the same policy framework; (2) Vertex Vector Search integration for retrieval; (3) agent observability via Cloud Trace and Cloud Logging without additional plumbing.

## When to pick Vertex Agent Platform

Pick it when your stack is already Google Cloud and you want IAM-native agent permissions; pick it when you need Workspace integration; pick it when your data is in BigQuery and you want zero-config retrieval. Pick something else (Anthropic Managed Agents, AWS Bedrock Managed Agents, build-your-own with Claude Agent SDK or Vercel AI SDK 6) when you're not on Google Cloud or you want vendor-neutral portability.
