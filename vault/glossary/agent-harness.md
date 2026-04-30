---
term: "Agent harness"
definition: "An agent harness is a software framework that runs an LLM in a loop with tool access, persistent context, and a stopping criterion — turning a one-shot model call into a multi-step workflow that can plan, execute, observe results, and re-plan until a task is complete."
category: "agent runtime"
related_terms: [tool-use, mcp, planner-executor, harness-engineering]
related_courses: [production-agents-claude-agent-sdk-mcp-connector, mcp-from-first-principles-to-production]
sameAs: []
---

The term gained prominence with Anthropic's April 2026 paper "Harness Engineering" describing the Planner → Generator → Evaluator pattern with structured handoffs and context resets. Major agent harnesses as of April 2026 include Claude Code (Anthropic's terminal-native harness), Cursor 3.x (IDE-native), Aider (CLI), Plandex (CLI with diff control), OpenCode (multi-vendor CLI), and emerging Vercel AI SDK 6 ToolLoopAgent.

Key harness design choices include: synchronous vs streaming; context window management (compression, summarization, or eviction); permission model (fully autonomous, plan-first, or step-confirmation); and tool surface (file edits, shell commands, browser, or all of the above).

Harnesses are differentiated from agent platforms (like Claude Agent SDK Managed Agents or Vertex Agent Platform) primarily by where the loop runs: harnesses run client-side; agent platforms run vendor-managed.
