---
course_slug: production-agents-claude-agent-sdk-mcp-connector
chapter_num: 1
chapter_slug: sdk-rename-what-changed
title: "What changed when Claude Code SDK became Claude Agent SDK"
status: draft-for-review
author: vardaan-koenig
agent_drafted_by: course-author
date: 2026-04-30
duration_min: 35
prerequisites_chapters: []
learning_objectives:
  - "Identify the five most important breaking changes between Claude Code SDK and Claude Agent SDK"
  - "Update package.json / requirements.txt and all imports to the new package names"
  - "Run a basic query() call that proves the migration succeeded"
  - "Explain what the rename signals about Anthropic's product direction"
key_concepts:
  [sdk-rename, query-api, built-in-tools, session-ids, bedrock-vertex-auth, package-names]
hands_on_exercise: "Migrate a three-tool code-reviewer agent from Claude Code SDK to Claude Agent SDK and verify session state is captured"
sources:
  - https://code.claude.com/docs/en/agent-sdk/overview
  - https://claude.com/blog/agent-capabilities-api
  - https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk
---

# What changed when Claude Code SDK became Claude Agent SDK

The Claude Agent SDK is Anthropic's official library for embedding an autonomous agent loop — including built-in file operations, shell execution, web access, and subagent spawning — directly into a Python or TypeScript application, renamed from the Claude Code SDK in April 2026 alongside the public beta of Claude Managed Agents.

On April 8, 2026, Anthropic simultaneously shipped the renamed SDK, the Managed Agents REST API, and an explicit MCP connector guide. The rename wasn't a rebrand of the package alone; it came with a branding prohibition — partners may no longer call their products "Claude Code" or use Claude Code ASCII art — and with a note that Opus 4.7 requires SDK version v0.2.111 or later [1].

> **Prerequisites**: None — this is Chapter 1.
>
> **Time**: 35 minutes
>
> **Learning objectives**: By the end of this chapter you can install the renamed SDK, update your imports, run your first `query()` call, and explain what the rename means for your production roadmap.

## Key facts

1. The npm package changed from `@anthropic-ai/claude-code-sdk` to `@anthropic-ai/claude-agent-sdk`; the PyPI package changed from `claude-code` to `claude-agent-sdk` [1].
2. Opus 4.7 (`claude-opus-4-7`) requires Agent SDK v0.2.111 or later; older SDK versions throw a `thinking.type.enabled` API error when targeting Opus 4.7 [1].
3. The TypeScript SDK bundles a native Claude Code binary for your platform as an optional dependency — you no longer need a separate Claude Code installation [1].
4. Authentication on Amazon Bedrock, Google Vertex AI, and Microsoft Azure Foundry is controlled entirely by environment variables (`CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`), not constructor arguments [1].
5. The branding guidelines explicitly prohibit partners from using the names "Claude Code," "Claude Code Agent," or Claude Code-branded ASCII art — a signal that the SDK is now a platform, not a feature of a specific product [1].
6. Session state is stored as JSONL on your filesystem and can be resumed by passing `resume: sessionId` in your options [1].

## The rename isn't cosmetic

Most developers saw the April 2026 announcement and ran `npm install @anthropic-ai/claude-agent-sdk`. Done, right? Not quite.

The rename matters strategically because it de-couples the SDK from Claude Code the developer product. Claude Code is a terminal app; the Claude Agent SDK is now a general-purpose platform library. By prohibiting partners from calling their products "Claude Code," Anthropic is drawing a hard line: Claude Code is the consumer app, the Agent SDK is the infrastructure you build on. If you're building a product on top of this SDK, that distinction matters for your own naming and positioning.

There's also a real technical signal in the version requirement. Requiring v0.2.111 for Opus 4.7 means Anthropic is now coupling model releases to SDK versions in a way they weren't before. You need to track SDK versions actively, not just pin to a major.

## Installing the renamed SDK

### TypeScript

```bash
# Remove the old package
npm uninstall @anthropic-ai/claude-code-sdk

# Install the renamed package
npm install @anthropic-ai/claude-agent-sdk
```

### Python

```bash
# Remove the old package
pip uninstall claude-code

# Install the renamed package
pip install claude-agent-sdk
```

After installing, verify the version:

```bash
# TypeScript: check package.json
cat package.json | grep claude-agent-sdk
# → "@anthropic-ai/claude-agent-sdk": "^0.2.111"

# Python: check installed version
pip show claude-agent-sdk
# → Version: 0.2.111 (or later)
```

## Updating your imports

Every import in your existing code needs to change. This is a search-and-replace operation, not a logic change.

### TypeScript — before

```typescript
import { query } from "@anthropic-ai/claude-code-sdk";
import type { ClaudeCodeOptions } from "@anthropic-ai/claude-code-sdk";
```

### TypeScript — after

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeAgentOptions } from "@anthropic-ai/claude-agent-sdk";
```

Note: the options type renamed from `ClaudeCodeOptions` to `ClaudeAgentOptions`.

### Python — before

```python
from claude_code_sdk import query, ClaudeCodeOptions
```

### Python — after

```python
from claude_agent_sdk import query, ClaudeAgentOptions
```

<Callout type="warn">
Do a project-wide search for `claude_code_sdk` and `claude-code-sdk` before shipping. Import aliases (`as sdk`) can hide stale references that only surface at runtime. Also check `.mcp.json` files and any shell scripts that reference the old binary name.
</Callout>

## The `query()` API in 2 minutes

The core API hasn't changed between SDK versions. `query()` is an async generator that yields message objects as the agent works through a task. The simplest possible call:

```python
import asyncio
from claude_agent_sdk import query, ClaudeAgentOptions

async def main():
    async for message in query(
        prompt="What files are in this directory?",
        options=ClaudeAgentOptions(allowed_tools=["Bash", "Glob"]),
    ):
        if hasattr(message, "result"):
            print(message.result)

asyncio.run(main())
```

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt: "What files are in this directory?",
  options: { allowedTools: ["Bash", "Glob"] }
})) {
  if ("result" in message) console.log(message.result);
}
```

The generator yields several message types. The ones you'll care about most:

| Type | When it fires | What it contains |
|---|---|---|
| `SystemMessage` (subtype `init`) | First, before any work | Session ID, connected MCP servers |
| `AssistantMessage` | After each model turn | Claude's text + tool calls |
| `ToolResultMessage` | After each tool execution | The tool's output |
| `ResultMessage` | Last | Final answer, token usage, session ID |

<RunPromptCell
  model="claude-sonnet-4-6"
  prompt="What is the current working directory? List the files in it."
  expectedOutput="The agent calls Bash with `pwd` and `ls`, then returns the directory path and a list of files. You see AssistantMessage objects containing tool_use blocks, followed by ToolResultMessage objects with the shell output, ending with a ResultMessage containing the synthesized answer."
/>

## Capturing and resuming sessions

Session continuity is one of the most underused features of the SDK. When the `SystemMessage` with subtype `init` arrives, grab the `session_id`:

```python
import asyncio
from claude_agent_sdk import query, ClaudeAgentOptions, SystemMessage, ResultMessage

session_id = None

async def first_query():
    global session_id
    async for message in query(
        prompt="Read auth.py and tell me what it does",
        options=ClaudeAgentOptions(allowed_tools=["Read", "Glob"]),
    ):
        if isinstance(message, SystemMessage) and message.subtype == "init":
            session_id = message.data["session_id"]
        if isinstance(message, ResultMessage):
            print(message.result)

async def follow_up():
    async for message in query(
        prompt="Now find every file that imports from auth.py",
        options=ClaudeAgentOptions(resume=session_id),
    ):
        if isinstance(message, ResultMessage):
            print(message.result)

async def main():
    await first_query()
    await follow_up()  # Claude already knows auth.py's contents

asyncio.run(main())
```

The `resume` option re-opens the existing JSONL session file on your filesystem. Claude picks up with full context from the previous turn — no re-reading files, no redundant tool calls.

<Callout type="info">
Session files live under `~/.claude/sessions/` by default. They're JSONL, not encrypted, and can be large for long-running agents. In production, set `CLAUDE_SESSIONS_DIR` to a path with appropriate retention policies.
</Callout>

## Built-in tools: the complete list

The Agent SDK ships ten built-in tools. You must declare which ones you allow explicitly — there's no "allow all built-ins" shortcut:

| Tool | What it does | Safe to allow broadly? |
|---|---|---|
| `Read` | Read any file in the working directory | Yes |
| `Write` | Create new files | With caution |
| `Edit` | Make precise edits to existing files | With caution |
| `Bash` | Run terminal commands, scripts, git operations | No — scope carefully |
| `Monitor` | Watch a background script, react to each stdout line | Yes |
| `Glob` | Find files by pattern (`**/*.ts`, `src/**/*.py`) | Yes |
| `Grep` | Search file contents with regex | Yes |
| `WebSearch` | Search the web for current information | Yes |
| `WebFetch` | Fetch and parse web page content | Yes |
| `AskUserQuestion` | Ask the user clarifying questions with multiple choice | Yes |

The `Bash` tool is the one to be careful with. In a CI context with a fully sandboxed container it's fine. On a developer workstation, `Bash` can delete files, install packages, and run arbitrary code. If you don't need shell execution, don't include it.

## Multi-cloud authentication

If you run behind Bedrock, Vertex AI, or Azure, the SDK respects environment variables — you don't change any code:

```bash
# Amazon Bedrock
export CLAUDE_CODE_USE_BEDROCK=1
# Then configure AWS credentials normally
aws configure  # or use IAM roles

# Google Vertex AI
export CLAUDE_CODE_USE_VERTEX=1
# Then configure GCloud credentials
gcloud auth application-default login

# Microsoft Azure AI Foundry
export CLAUDE_CODE_USE_FOUNDRY=1
# Then configure Azure credentials
az login
```

The `ANTHROPIC_API_KEY` environment variable is still checked first. If it's set, it wins over cloud provider credentials.

<RunPromptCell
  model="claude-sonnet-4-6"
  prompt="Find all TypeScript files in this project that import from '@anthropic-ai/claude-code-sdk' and list their paths."
  expectedOutput="The agent uses Grep with pattern '@anthropic-ai/claude-code-sdk' and glob '**/*.ts', returns a list of file paths that still use the old import. This is the first step of a real migration audit."
/>

## Hands-on exercise

**Migrate a code-reviewer agent to the Claude Agent SDK.**

Start with this minimal Claude Code SDK agent (or your own existing code):

```python
# reviewer_old.py — uses the old SDK
from claude_code_sdk import query, ClaudeCodeOptions

async def review_code(file_path: str):
    async for message in query(
        prompt=f"Review {file_path} for bugs and code quality issues",
        options=ClaudeCodeOptions(
            allowed_tools=["Read", "Glob", "Grep"],
        ),
    ):
        if hasattr(message, "result"):
            print(message.result)
```

Your tasks:
1. Install `claude-agent-sdk` (Python) or `@anthropic-ai/claude-agent-sdk` (TypeScript)
2. Update the import to `from claude_agent_sdk import query, ClaudeAgentOptions`
3. Rename `ClaudeCodeOptions` to `ClaudeAgentOptions`
4. Add session capture: print the `session_id` from the `SystemMessage`
5. Run the agent against any `.py` or `.ts` file in your project

**Verification**: The agent runs without import errors, produces a code review, and prints a session ID that looks like `sess_01XxXxxXx…`.

**Estimated time**: 15 minutes

<KnowledgeCheck
  question="You're migrating a Python project from the Claude Code SDK to the Claude Agent SDK. Which of the following changes is required?"
  options={[
    "Replace `from claude_code_sdk import query` with `from claude_agent_sdk import query`",
    "Replace `from anthropic import Anthropic` with `from claude_agent_sdk import Anthropic`",
    "Replace `ClaudeCodeOptions` with `AgentOptions` (not ClaudeAgentOptions)",
    "Add an `agent_version` parameter to every `query()` call"
  ]}
  correctIdx={0}
  explanation="The package rename is the only required import change. The class is `ClaudeAgentOptions` (not `AgentOptions`). The `Anthropic` client from the anthropic package is unchanged — it's the separate Messages/Managed Agents client, not the Agent SDK. The `query()` signature has no `agent_version` parameter."
/>

<KnowledgeCheck
  question="Your team has pinned to `@anthropic-ai/claude-agent-sdk@^0.2.100` and wants to use `claude-opus-4-7`. What will happen and what should you do?"
  options={["self-check"]}
  correctIdx={0}
  explanation="Self-check: Opus 4.7 requires v0.2.111 or later. With ^0.2.100, npm will install the latest 0.2.x patch — which may or may not be ≥ 0.2.111 depending on when you run install. The safe fix is to pin to `^0.2.111` or later. If you see a `thinking.type.enabled` API error, that's the symptom of this version mismatch."
/>

## Subagents: orchestrating specialized agents

One of the most powerful Agent SDK features is the ability to spawn specialized subagents from within a parent agent. Subagents handle focused subtasks and report back results, enabling you to build multi-agent pipelines entirely in Python or TypeScript:

```python
import asyncio
from claude_agent_sdk import query, ClaudeAgentOptions, AgentDefinition, ResultMessage

async def review_and_document(codebase_path: str):
    """Parent agent that delegates to two specialists."""
    async for message in query(
        prompt=f"Use the code-reviewer agent to review {codebase_path}, then use the doc-writer agent to create a README.",
        options=ClaudeAgentOptions(
            allowed_tools=["Read", "Glob", "Grep", "Write", "Agent"],
            agents={
                "code-reviewer": AgentDefinition(
                    description="Expert code reviewer for quality and security.",
                    prompt="Analyze code quality, identify bugs, suggest improvements.",
                    tools=["Read", "Glob", "Grep"],
                ),
                "doc-writer": AgentDefinition(
                    description="Technical writer who creates clear documentation.",
                    prompt="Write clear, accurate technical documentation.",
                    tools=["Read", "Write"],
                ),
            },
        ),
    ):
        if isinstance(message, ResultMessage):
            print(message.result)

asyncio.run(review_and_document("./src"))
```

The `Agent` tool must be in `allowedTools` for the parent to spawn subagents. Messages from within a subagent's context include a `parent_tool_use_id` field — use this to correlate subagent output back to the parent's tool call in your audit logs.

Note the pattern: the parent doesn't implement the reviewer or writer logic itself. It delegates, which keeps the parent's context window focused on orchestration rather than implementation. This is the right architecture for agents with more than two or three distinct skill sets.

## Configuration file loading order

The SDK loads configuration from multiple sources, applied in a defined order. Understanding this prevents "why isn't my setting taking effect?" debugging sessions:

```
~/.claude/settings.json          # global user settings (lowest priority)
~/.claude/CLAUDE.md              # global system prompt additions
.claude/settings.json            # project settings
.claude/CLAUDE.md / CLAUDE.md    # project system prompt
inline ClaudeAgentOptions()      # runtime options (highest priority)
```

Later sources override earlier ones. This means you can set safe defaults globally and override them per-project or per-run without touching the global config.

To restrict which sources load — for example, in a CI environment where you don't want the developer's `~/.claude` settings to affect the build — use `settingSources`:

```python
options = ClaudeAgentOptions(
    allowed_tools=["Read", "Glob", "Grep"],
    setting_sources=["project"],  # only load .claude/ in the current project
)
```

```typescript
const options = {
  allowedTools: ["Read", "Glob", "Grep"],
  settingSources: ["project"],  // ignores ~/.claude entirely
};
```

This is important for reproducibility: a CI agent should behave identically regardless of what's installed in the developer's home directory.

## Skills and slash commands

The Agent SDK supports two additional configuration primitives that most tutorials skip: Skills and slash commands. Both are defined in Markdown files and loaded from the project `.claude/` directory.

**Skills** are specialist instructions that extend the agent's capabilities for specific domains. A `SKILL.md` file at `.claude/skills/<name>/SKILL.md` is loaded into context when the agent needs that capability. This is how the Koenig AI Academy's own agents are extended — each agent has skills for its specialized workflows without bloating the base system prompt.

**Slash commands** are shorthand for common task templates. A `review.md` file at `.claude/commands/review.md` becomes a `/review` command that the agent can invoke. In the SDK context, you can trigger slash commands by starting a prompt with `/`.

These are the same skill and command systems that power Claude Code's daily usage, now fully available to your programmatic agents.

## What's next

In Chapter 2 you'll meet Managed Agents — Anthropic's hosted agent harness that launched the same day as this SDK rename. You'll learn the decision rule for when to let Anthropic run your agent infrastructure vs running it yourself, and you'll wire up your first session with full SSE streaming. The pricing model has a non-obvious trap that most tutorials skip: we'll name it explicitly.

## References

[1] Claude Agent SDK Overview — https://code.claude.com/docs/en/agent-sdk/overview · retrieved 2026-04-30
[2] Agent Capabilities API announcement — https://claude.com/blog/agent-capabilities-api · retrieved 2026-04-30
[3] @anthropic-ai/claude-agent-sdk on npm — https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk · retrieved 2026-04-30
[4] Claude Agent SDK MCP documentation — https://code.claude.com/docs/en/agent-sdk/mcp · retrieved 2026-04-30
[5] Claude Managed Agents Overview — https://platform.claude.com/docs/en/managed-agents/overview · retrieved 2026-04-30
