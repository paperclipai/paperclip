# Agent Roster Expansion Specs (ROCAA-230)

## Overview
This document outlines the specs for the new agents requested by Ivan (2026-05-24). Approval is required before execution via `paperclip-create-agent`.

## Constraints & Routing
- **Company Alignment**: OPS agents on ROC Ops; Infra agents on ROC Dev.
- **Reporting**: OPS agents report to Ivan + Yauvan; Dev agents report to Ivan.
- **Memory Layer**: Tie into RAG/memory layer (ROCAA-226) for context-awareness.
- **Access**: Least-privilege tool scope and strict budget caps applied.

---

## 1. Finance Agent (EXISTS)
- **Role**: Finance Steward
- **Company**: ROC Ops
- **Action Required**: Route cost/spend reporting (RunPod, tier usage, observability $) to this agent once live.
- **Budget / Scope**: Pre-existing; read-only access to billing APIs and Secret Manager (gated on ROC-302).

## 2. Sales Agent (NEW)
- **Role**: Sales Engagement & Pipeline
- **Company**: ROC Ops
- **Adapter**: claude_local
- **Reporting**: Ivan + Yauvan
- **Tool Scope**: GHL, Salesforce (read/update pipeline status), email/SMS tools, RAG memory (leads context).
- **Budget Cap**: $100/day
- **Description**: Handles top-of-funnel pipeline and lead engagement, nurturing leads to booking stages.

## 3. Closer Agent (NEW)
- **Role**: Deal & Loan Closing
- **Company**: ROC Ops
- **Adapter**: claude_local
- **Reporting**: Ivan + Yauvan
- **Tool Scope**: Blend (read/write docs), Salesforce, email tools, RAG memory (loan context).
- **Budget Cap**: $100/day
- **Description**: Focuses on deep-funnel progression, condition collection, and processing to funded status.

## 4. Voice AI Agents (EXISTING IN GHL)
- **Role**: GHL Voice AI
- **Company**: ROC Ops
- **Action Required**: Integrate and acknowledge as the primary voice lane. Do not rebuild.
- **Tool Scope**: GHL Voice Webhooks -> Paperclip signal bus.
- **Description**: Surface voice AI activity and outcomes into Paperclip for cross-agent visibility.

## 5. Research Agent (NEW)
- **Role**: Swarm Research & Data
- **Company**: ROC Dev
- **Adapter**: gemini_local
- **Reporting**: Ivan
- **Tool Scope**: browser, web_extract, github_search, RAG memory.
- **Budget Cap**: $25/day
- **Description**: Serves both Dev and Ops for market research, competitor analysis, and documentation lookups.

## 6. Paperclip Worker (NEW)
- **Role**: General Purpose / Sweeper
- **Company**: ROC Dev
- **Adapter**: gemini_local
- **Reporting**: Ivan
- **Tool Scope**: terminal (sandboxed), read_file, write_file, search_files.
- **Budget Cap**: $50/day
- **Description**: Handles routine Dev repo maintenance, ticket cleanup, and broad refactoring sweeps.

## 7. Hermes Agent (NEW)
- **Role**: High-Autonomy Control
- **Company**: ROC Dev
- **Adapter**: hermes_local (Phase 3 / ROCAA-228)
- **Reporting**: Ivan
- **Tool Scope**: Full suite (terminal, process, patch, vault_commit, etc.) strictly bound by L1/L2/L3 guards.
- **Budget Cap**: $150/day
- **Description**: See detailed `vault/wiki/Hermes-Sandbox-Spec.md` for extended directives.
