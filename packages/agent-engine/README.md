# @paperclipai/agent-engine

Lightweight, transparent agent engine for the Paperclip framework.

## Purpose

This package provides the core runtime primitives that Paperclip agents use to
interact with their environment:

- **Typed tool definitions** — structured parameters with JSON Schema
- **Tool registry** — discover and invoke tools by name
- **System prompt builder** — construct prompts that describe available tools and operational rules
- **Built-in filesystem tools** — `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`

The engine is intentionally minimal. It does not include an LLM client or agent
loop — those are provided by the adapter or host that consumes the engine.

## Design principles

- **Transparent** — every tool call is observable and debuggable
- **Typed** — full TypeScript coverage for parameters and results
- **Extensible** — register custom tools alongside built-ins
- **CLI-first** — tools map to common shell and filesystem operations

## Usage

```ts
import { createAgentEngine, buildSystemPrompt } from "@paperclipai/agent-engine";

const engine = createAgentEngine({
  cwd: "/path/to/workspace",
  env: { NODE_ENV: "development" },
  toolTimeoutMs: 60_000,
  maxToolOutputBytes: 50 * 1024,
});

// Build a system prompt that includes tool descriptions
const systemPrompt = engine.buildSystemPrompt({
  role: "Senior Engineer",
  title: "Code Reviewer",
  mission: "Review pull requests for quality and correctness.",
  cwd: "/path/to/workspace",
});

// Execute a tool directly
const result = await engine.executeTool("read", { path: "README.md" });
console.log(result.content);

// Register a custom tool
engine.tools.register({
  name: "deploy",
  displayName: "Deploy",
  description: "Deploy the current branch to staging.",
  parametersSchema: { type: "object", properties: {}, required: [] },
  execute: async () => ({ content: "Deployed!" }),
});
```

## Built-in tools

| Tool   | Description                                      |
|--------|--------------------------------------------------|
| `read` | Read file contents (text and images)             |
| `write`| Write content to a file                          |
| `edit` | Edit a file with exact text replacement          |
| `bash` | Execute bash commands                            |
| `grep` | Search file contents for patterns                |
| `find` | Find files by glob pattern                       |
| `ls`   | List directory contents                          |

## Architecture

```
┌─────────────────┐
│  Adapter / Host │  (LLM client, heartbeat loop)
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  AgentEngine    │  (tool registry, prompt builder, execution)
└────────┬────────┘
         │
    ┌────┴────┐
    ▼         ▼
┌───────┐ ┌─────────┐
│ Tools │ │ Prompt  │
└───────┘ └─────────┘
```

## Related

- `@paperclipai/adapter-utils` — adapter contracts and execution targets
- `@paperclipai/mcp-server` — MCP server exposing Paperclip API tools
