---
name: "Claude Agent SDK"
kind: agent-sdk
one_liner: "The Claude Agent SDK is Anthropic's TypeScript and Python toolkit for building production agents on the Claude API — rebranded from Claude Code SDK in April 2026 to reflect its broadening role as the canonical Anthropic agent runtime, with first-class support for tool use, MCP, Files API, code execution, and Managed Agents."
shipped: "2026-04-28"
status: ga
description: "Anthropic's official agent-building SDK, rebranded from Claude Code SDK."
primary_url: "https://docs.anthropic.com/en/docs/agents/agent-sdk"
related_terms: [agent-harness, tool-use, mcp]
related_courses: [production-agents-claude-agent-sdk-mcp-connector]
related_blogs: [anthropic-agent-sdk-april-rebrand]
sameAs: []
---

## What changed in the rebrand

The Claude Code SDK (originally released in late 2025 as the underlying library that Claude Code the CLI consumes) was renamed to Claude Agent SDK on April 28, 2026 to signal that it's now the canonical way to build any agent on the Anthropic API — not just terminal-style coding agents.

The rebrand was paired with three new capabilities: Managed Agents (vendor-managed agent loops with conversation persistence), MCP Connector API (use Anthropic-managed MCP servers from your own API calls), and Files API (uploaded files become first-class context).

## When to use the Agent SDK vs raw Anthropic API

Use the Agent SDK when: you're building a multi-turn agent with tool use, you want streaming + structured output handling, or you want Managed Agents (Anthropic runs the loop). Use the raw API when: you're doing single-turn inference, or you've built your own agent harness and just need model access.

## Managed Agents (beta)

Managed Agents are vendor-hosted agent loops — you provide tools and a system prompt, Anthropic runs the loop with conversation state, observability, and retries. As of April 2026 it's in beta with quotas; GA expected mid-2026. Pricing adds a small premium per agent-turn on top of model cost.
