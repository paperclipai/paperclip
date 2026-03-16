---
name: context-cost-management
category: context-cost
description: Use when managing Claude Code context, controlling costs, hitting rate limits, or diagnosing session degradation. Triggers on: "hitting rate limits", "claude code slow", "context window full", "/compact", "context collapse", "MCP too many tokens", "session degrading", "token budget", "claude code expensive", "session checkpointing", "model routing haiku sonnet opus", "CLAUDE.md audit", "MCP optimization", "cold start session", "context mode", "usage limits". Also fires for: unaudited MCP stacks consuming 143K tokens before first message, Max subscribers hitting limits mid-session, unexplained $100+ monthly bills, session degradation after 30-60 minutes, and "did the model get worse or did my config break". NOT for: MCP server installation/configuration, Enterprise billing dashboards (Bedrock/Vertex), API-level prompt optimization, or token optimization in your own prompts.
---

# Claude Code Context & Cost Management

Most Claude Code slowdowns, limit-hits, and cost explosions aren't about Claude — they're about unaudited context and unmanaged session hygiene. Token auditing, strategic `/compact`, MCP slimming, and model routing can extend session longevity 10x and cut spend 15x without changing a line of code.

## Customization

**Before executing, check for user customizations:**
1. Read `{project}/.claude/skill-customizations/context-cost-management/PREFERENCES.md` (if exists)
2. Read `~/.claude/skill-customizations/context-cost-management/PREFERENCES.md` (if exists)
3. Project-local overrides global. Both override skill defaults.
4. If neither exists, proceed with skill defaults.

## Workflow Routing

| Symptom / Request | Route To |
|---|---|
| "What's eating my context budget?" | `Workflows/TokenAudit.md` |
| "When should I run /compact?" | `Workflows/CompactGuide.md` |
| "My MCP tools are consuming everything" | `Workflows/McpSlimming.md` |
| "How do I cut my bill 10x?" | `Workflows/ModelRouting.md` |
| "I'm hitting rate limits mid-session" | `Workflows/RateLimits.md` |
| "I need to pause and resume a session" | `Workflows/SessionCheckpointing.md` |
| "Did the model regress or did my config break?" | `Workflows/DiagnosingRegressions.md` |

## Dispatch Rules
- Match the user's symptom to the routing table above
- Read the matched workflow file and follow its instructions
- If no clear match, ask which symptom is closest
- Workflows reference files in `references/` for supporting detail

## Anti-Rationalization

| What you'll tell yourself | The truth |
|---|---|
| "My MCP setup is fine, I don't have that many tools" | Count them. 20 tools × 1,500 tokens = 30K tokens before your first message. Audit first, assume later. |
| "/compact is automatic, I don't need to manage it" | Auto-compact fires at 95%. You've already degraded. Manual /compact at 60% prevents degradation, not just the hard stop. |
| "I'll optimize costs when the bill gets high" | By then you've normalized the spend. Model routing takes 15 minutes to set up and saves 15x immediately. |
| "Starting fresh loses too much context" | That's what checkpointing is for. /clear with a good handoff is faster than nursing a degraded session. |
| "Model routing is overkill for my project" | If you're spawning any subagents, you're either routing already or burning Opus rates on Haiku tasks. One line. |
| "I can tell when the session is degrading" | Usually not. Context collapse is gradual. By the time you notice, you've been degraded for 30 minutes. |
