---
title: "AI Assistant (CopilotKit)"
description: "Use the built-in AI chat sidebar to manage your Paperclip workspace with natural language."
---

## Overview

Paperclip includes an AI assistant powered by [CopilotKit](https://copilotkit.ai) that lets you manage your workspace using natural language. The assistant appears as a slide-out sidebar on the right side of the dashboard.

## Getting Started

### Prerequisites

Set the following environment variables on your Paperclip server:

```bash
OPENAI_API_KEY=sk-...           # Required — any OpenAI-compatible key
COPILOTKIT_MODEL=gpt-4o-mini    # Optional — defaults to gpt-4o-mini
```

### Opening the Assistant

Click the chat icon in the bottom-right corner of any page, or look for the assistant sidebar toggle. The assistant is available on every page within the board layout.

## What You Can Do

The assistant has access to every entity in your Paperclip workspace:

| Category | Actions |
|----------|---------|
| **Navigation** | Navigate to any page, switch between companies |
| **Issues** | List, create, update, delete issues; add comments; manage labels |
| **Projects** | List, create, update, delete projects |
| **Goals** | List, create, update goals |
| **Agents** | List agents, view details, pause/resume/terminate, trigger heartbeats |
| **Approvals** | List, approve, reject, or request revision on approvals |
| **Costs** | View cost summaries, breakdowns by agent or project |
| **Activity** | View recent activity, issue history |
| **Secrets** | List and create secrets (values are never returned) |
| **Dialogs** | Open creation dialogs with pre-filled data |

## Example Prompts

- "Show me all open issues assigned to the DevBot agent"
- "Create a new issue titled 'Fix login page' with high priority"
- "What's the cost breakdown for this month?"
- "Pause the ResearchBot agent"
- "Navigate to the approvals page"
- "How many issues are in backlog?"
- "Approve the pending hire request"

## Context Awareness

The assistant automatically knows:

- **Current page** — It sees which page you're viewing and tailors suggestions accordingly.
- **Selected company** — All actions are scoped to the company you're currently working in.
- **Available companies** — It can help you switch between companies.

## Architecture

The integration consists of three parts:

1. **CopilotKit Provider** (`ui/src/main.tsx`) — Wraps the app and connects to the runtime endpoint at `/api/copilotkit`.
2. **CopilotKit Runtime** (`server/src/routes/copilotkit.ts`) — Express route that proxies chat requests through the OpenAI adapter.
3. **Actions & Readables** (`ui/src/hooks/useCopilotActions.ts`) — Registers 35+ actions and context readables that the LLM can call.

All actions call the same Paperclip REST APIs used by the UI itself, so permissions and data are consistent.
