---
course_slug: production-agents-claude-agent-sdk-mcp-connector
chapter_num: 3
chapter_slug: mcp-connector-multi-server
title: "MCP connector: orchestrating multi-server agents"
status: draft-for-review
author: vardaan-koenig
agent_drafted_by: course-author
date: 2026-04-30
duration_min: 50
prerequisites_chapters: [1]
learning_objectives:
  - "Configure stdio, HTTP, and SSE MCP servers in a single query() call"
  - "Scope MCP tool access with allowedTools wildcards and per-tool grants"
  - "Detect and handle server connection failures via the system init message"
  - "Explain why permissionMode acceptEdits is NOT sufficient for MCP tool approval"
key_concepts:
  [mcp-tool-naming, mcpServers, transport-types, mcp-json, tool-search, oauth2-headers, connection-timeout]
hands_on_exercise: "Wire a GitHub MCP server (stdio) and a Postgres MCP server (stdio) and a cloud docs server (HTTP) into one agent that pulls an issue, queries a related DB table, and writes a summary"
sources:
  - https://code.claude.com/docs/en/agent-sdk/mcp
  - https://modelcontextprotocol.io/docs/getting-started/intro
  - https://platform.claude.com/docs/en/agent-sdk/overview
---

# MCP connector: orchestrating multi-server agents

The Model Context Protocol (MCP) connector in the Claude Agent SDK is a built-in mechanism for attaching external tool servers — databases, APIs, browsers, and code execution environments — to an agent at runtime, using a standard open protocol that Anthropic co-developed with the broader AI ecosystem in 2024.

When Anthropic shipped the [[course/production-agents-claude-agent-sdk-mcp-connector/01-sdk-rename-what-changed|Agent SDK]] rename in April 2026, the MCP connector shipped with it as a first-class feature rather than a configuration hack. The connector supports three transport modes — stdio for local process servers, HTTP for stateless remote APIs, and SSE for streaming remote servers — and handles connection management, tool discovery, and error signaling automatically [1]. As of April 2026, the public MCP server registry lists hundreds of community servers for databases, SaaS tools, and developer infrastructure, though quality varies considerably.

> **Prerequisites**: Chapter 1 (Agent SDK installed, one successful `query()` call)
>
> **Time**: 50 minutes
>
> **Learning objectives**: By the end of this chapter you can wire three MCP servers of different transport types into a single agent, scope permissions correctly, and handle connection failures before the agent starts working.

## Key facts

1. MCP tools follow the naming pattern `mcp__<server-name>__<tool-name>` — e.g., the GitHub server named `"github"` with a `list_issues` tool becomes `mcp__github__list_issues` [1].
2. MCP tools require explicit permission via `allowedTools`; `permissionMode: "acceptEdits"` does NOT auto-approve MCP tools [1].
3. Three transport types: stdio (local processes), HTTP (stateless remote), SSE (streaming remote). A fourth option — SDK MCP servers — runs tools in-process as code [1].
4. The default connection timeout for stdio servers is 60 seconds; servers that take longer to start fail silently unless you check the `init` system message [1].
5. Tool search is enabled by default when many MCP tools are configured, withholding tool definitions from the context window and loading only what Claude needs per turn [1].
6. OAuth2 credentials are handled manually: complete the OAuth flow in your application, then pass the access token via `headers` in the MCP server config [1].

## The MCP naming convention

Understanding the naming pattern is the foundation for everything that follows. Given an `mcpServers` config entry with key `"github"`, every tool that server exposes gets prefixed with `mcp__github__`. If the GitHub server exposes `list_issues`, `search_issues`, `create_issue`, and `get_pull_request`, their agent-visible names are:

```
mcp__github__list_issues
mcp__github__search_issues
mcp__github__create_issue
mcp__github__get_pull_request
```

This prefix structure matters because it's what you put in `allowedTools`. The wildcard pattern `mcp__github__*` allows all tools from the `github` server. The explicit pattern `mcp__github__list_issues` allows only that one tool.

## The three transport types

### stdio — local process servers

stdio is the most common transport for development and for community-published servers on npm or PyPI. The SDK spawns a child process and communicates over stdin/stdout.

```python
from claude_agent_sdk import query, ClaudeAgentOptions

options = ClaudeAgentOptions(
    mcp_servers={
        "github": {
            "command": "npx",
            "args": ["-y", "@modelcontextprotocol/server-github"],
            "env": {"GITHUB_TOKEN": "ghp_xxxxxxxxxxxx"},
        }
    },
    allowed_tools=["mcp__github__list_issues", "mcp__github__search_issues"],
)

async for message in query(
    prompt="List the 5 most recent open issues in anthropics/claude-code",
    options=options,
):
    if hasattr(message, "result"):
        print(message.result)
```

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt: "List the 5 most recent open issues in anthropics/claude-code",
  options: {
    mcpServers: {
      github: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        env: { GITHUB_TOKEN: process.env.GITHUB_TOKEN }
      }
    },
    allowedTools: ["mcp__github__list_issues", "mcp__github__search_issues"]
  }
})) {
  if (message.type === "result" && message.subtype === "success") {
    console.log(message.result);
  }
}
```

<Callout type="warn">
Never hard-code secrets in the `env` field. The values shown above are illustrative. Use `process.env.GITHUB_TOKEN` (TypeScript) or `os.environ["GITHUB_TOKEN"]` (Python) to pull from environment variables. The `.mcp.json` config file syntax uses `${GITHUB_TOKEN}` for shell-style expansion.
</Callout>

### HTTP — stateless remote servers

Use HTTP for cloud-hosted servers that expose a standard MCP endpoint. No child process, no local installation required:

```python
options = ClaudeAgentOptions(
    mcp_servers={
        "claude-code-docs": {
            "type": "http",
            "url": "https://code.claude.com/docs/mcp",
        }
    },
    allowed_tools=["mcp__claude-code-docs__*"],
)
```

```typescript
options = {
  mcpServers: {
    "remote-api": {
      type: "http",
      url: "https://api.yourcompany.com/mcp",
      headers: {
        Authorization: `Bearer ${process.env.API_TOKEN}`
      }
    }
  },
  allowedTools: ["mcp__remote-api__*"]
}
```

### SSE — streaming remote servers

SSE is the right transport when the remote server needs to push events as it processes (e.g., long-running queries, real-time data feeds):

```python
options = ClaudeAgentOptions(
    mcp_servers={
        "analytics-stream": {
            "type": "sse",
            "url": "https://analytics.yourcompany.com/mcp/sse",
            "headers": {"Authorization": f"Bearer {os.environ['ANALYTICS_TOKEN']}"},
        }
    },
    allowed_tools=["mcp__analytics-stream__*"],
)
```

The SDK transparently handles SSE reconnection — you don't need to manage the event stream yourself.

## Orchestrating three servers in one agent

This is where the real power emerges. You can configure multiple servers with different transport types in a single `mcpServers` dict. The agent uses whichever tools it needs based on the task:

```python
import asyncio
import os
from claude_agent_sdk import (
    query, ClaudeAgentOptions,
    SystemMessage, ResultMessage, AssistantMessage
)

async def investigate_issue(issue_ref: str, db_connection: str):
    """Pull a GitHub issue, query related DB records, write a summary."""
    options = ClaudeAgentOptions(
        mcp_servers={
            # stdio: GitHub MCP server
            "github": {
                "command": "npx",
                "args": ["-y", "@modelcontextprotocol/server-github"],
                "env": {"GITHUB_TOKEN": os.environ["GITHUB_TOKEN"]},
            },
            # stdio: Postgres MCP server
            "postgres": {
                "command": "npx",
                "args": ["-y", "@modelcontextprotocol/server-postgres", db_connection],
            },
            # HTTP: Cloud docs server
            "docs": {
                "type": "http",
                "url": "https://code.claude.com/docs/mcp",
            },
        },
        allowed_tools=[
            "mcp__github__get_issue",
            "mcp__github__list_comments",
            "mcp__postgres__query",        # read-only
            "mcp__docs__*",                # all doc tools
        ],
    )

    prompt = (
        f"1. Fetch the GitHub issue at {issue_ref}. "
        "2. Query the postgres DB for any records mentioning the issue number. "
        "3. Look up relevant documentation from the docs server. "
        "4. Write a one-paragraph summary of what the issue is about and whether the DB has related data."
    )

    async for message in query(prompt=prompt, options=options):
        # Verify all three servers connected on the first message
        if isinstance(message, SystemMessage) and message.subtype == "init":
            servers = message.data.get("mcp_servers", [])
            for server in servers:
                status = server.get("status")
                name = server.get("name")
                if status != "connected":
                    print(f"WARNING: {name} failed to connect — {server}")
        
        # Show which MCP tools are being called
        if isinstance(message, AssistantMessage):
            for block in message.content:
                if hasattr(block, "name") and block.name.startswith("mcp__"):
                    print(f"[MCP call: {block.name}]")
        
        if isinstance(message, ResultMessage) and message.subtype == "success":
            print(message.result)

asyncio.run(investigate_issue(
    issue_ref="anthropics/claude-code#1234",
    db_connection=os.environ["DATABASE_URL"],
))
```

## Why `permissionMode: "acceptEdits"` is not enough

This is the most common production mistake with MCP. The Agent SDK has three permission modes:

| Mode | What it auto-approves | Auto-approves MCP? |
|---|---|---|
| `default` | Nothing — every tool call prompts for approval | No |
| `acceptEdits` | File edit and filesystem Bash commands | **No** |
| `bypassPermissions` | Everything including MCP | Yes (but dangerous) |

`acceptEdits` is useful for coding agents that need to read and write files without prompting. But it explicitly does not cover MCP tools. If you set `acceptEdits` and rely on it to green-light your GitHub server, the agent will see the tools but refuse to call them.

The correct pattern is `allowedTools` with explicit grants:

```python
# WRONG — permissionMode doesn't cover MCP
options = ClaudeAgentOptions(
    permission_mode="acceptEdits",
    mcp_servers={"github": github_config},
)

# RIGHT — explicit allowedTools grants MCP access
options = ClaudeAgentOptions(
    permission_mode="acceptEdits",  # for file ops
    mcp_servers={"github": github_config},
    allowed_tools=["mcp__github__*"],  # for MCP ops
)
```

Using `bypassPermissions` to work around this is not the answer — it disables every safety check in the SDK, including approval prompts for destructive Bash operations.

## Detecting connection failures

MCP servers fail silently if you don't check for them. The `SystemMessage` with subtype `init` arrives before the agent does any work. It includes a `mcp_servers` list where each entry has a `status` field:

```python
async for message in query(prompt=..., options=options):
    if isinstance(message, SystemMessage) and message.subtype == "init":
        failed = [
            s for s in message.data.get("mcp_servers", [])
            if s.get("status") != "connected"
        ]
        if failed:
            # Abort or handle gracefully before the agent wastes tokens
            raise RuntimeError(f"MCP servers failed to connect: {failed}")
```

```typescript
for await (const message of query({ prompt, options })) {
  if (message.type === "system" && message.subtype === "init") {
    const failed = message.mcp_servers.filter(s => s.status !== "connected");
    if (failed.length > 0) {
      throw new Error(`MCP servers failed: ${JSON.stringify(failed)}`);
    }
  }
}
```

Common failure causes by transport:

- **stdio**: `npx` not on PATH, package not published, missing `env` vars
- **HTTP**: URL unreachable, invalid SSL certificate, wrong endpoint path
- **SSE**: CORS headers missing on the server, auth token expired

The default connection timeout for stdio servers is 60 seconds. If your server process takes longer than that to respond to its first handshake, it fails. Pre-warm slow servers before starting a query.

## Project-level config with `.mcp.json`

For projects where the same servers are always needed, put them in `.mcp.json` at the project root. The SDK loads this file automatically when `project` is in `settingSources` (the default):

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_TOKEN": "${GITHUB_TOKEN}"
      }
    },
    "postgres": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-postgres", "${DATABASE_URL}"]
    }
  }
}
```

The `${VAR}` syntax expands environment variables at load time. This keeps credentials out of your code while making the MCP config declarative and version-controllable.

<RunPromptCell
  model="claude-sonnet-4-6"
  prompt="I've configured an MCP server named 'github' with the @modelcontextprotocol/server-github package. What is the full tool name I should put in allowedTools to allow only the list_issues tool from this server?"
  expectedOutput="The correct value is `mcp__github__list_issues`. Claude explains the naming pattern: prefix `mcp__`, then the server name as it appears in the mcpServers key, then `__`, then the tool name. A wildcard to allow all GitHub tools would be `mcp__github__*`."
/>

## Tool search for large tool sets

When you configure many MCP servers simultaneously, their tool definitions can fill a significant portion of the context window. The SDK's tool search feature addresses this: it withholds tool definitions from context and loads only the ones Claude needs for each turn, based on a vector similarity search over the tool names and descriptions.

Tool search is enabled by default. You can verify it's active by checking whether long tool definition lists appear in your debug output. If you need to disable it for a specific server (e.g., a server with tools that always need to be in context), configure it in the `mcpServers` entry per the [tool search docs](https://code.claude.com/docs/en/agent-sdk/tool-search).

## OAuth2 authentication

For servers that require OAuth 2.1, the SDK doesn't handle the OAuth flow — that's your application's job. After you complete the flow and receive an access token, pass it as a header:

```python
access_token = await your_oauth_flow()  # your app handles PKCE/redirect

options = ClaudeAgentOptions(
    mcp_servers={
        "oauth-service": {
            "type": "http",
            "url": "https://your-service.com/mcp",
            "headers": {"Authorization": f"Bearer {access_token}"},
        }
    },
    allowed_tools=["mcp__oauth-service__*"],
)
```

Refresh token handling is also your responsibility. Wire token refresh into your session initialization code, not into the agent loop.

<RunPromptCell
  model="claude-sonnet-4-6"
  prompt="I see this in my init message: `{'name': 'postgres', 'status': 'failed', 'error': 'connection timeout'}`. What are the three most likely causes and how do I debug each one?"
  expectedOutput="Claude explains: (1) npx not installed or @modelcontextprotocol/server-postgres package missing — fix: run `npx @modelcontextprotocol/server-postgres --version` manually; (2) DATABASE_URL env var not set or malformed — fix: echo the variable and test with psql; (3) server process takes >60s to start (large package install, slow network) — fix: pre-install the package globally with `npm install -g @modelcontextprotocol/server-postgres` to eliminate startup time."
/>

## Hands-on exercise

**Wire a GitHub MCP server + a Postgres MCP server + the Claude Code docs HTTP server into one agent.**

Setup:
1. Install `@modelcontextprotocol/server-github` and `@modelcontextprotocol/server-postgres` via npx (they auto-install on first use)
2. Set `GITHUB_TOKEN` to a GitHub personal access token with `repo:read` scope
3. Set `DATABASE_URL` to a local Postgres instance (e.g., `postgresql://localhost/testdb`) — even a fresh empty DB works

Task prompt:
```
1. Get the README from the anthropics/claude-code repository on GitHub.
2. Search the postgres database for any table named 'issues' — if it doesn't exist, say so.
3. Look up what 'hooks' are in the Agent SDK using the docs MCP server.
4. Write a three-sentence summary combining what you found.
```

**Verification**:
- The `init` message shows all three servers with `status: "connected"`
- You see at least two different `mcp__*` tool calls in the output (one GitHub, one docs at minimum)
- The summary references Claude Code and hooks with specific details from the docs

**Estimated time**: 25 minutes

<KnowledgeCheck
  question="Your agent is configured with `permissionMode: 'acceptEdits'` and an MCP server named `db`. You've added the server to `mcpServers` but NOT listed any MCP tools in `allowedTools`. What happens when Claude tries to call `mcp__db__query`?"
  options={[
    "The tool call is blocked — MCP tools require explicit allowedTools grants regardless of permissionMode",
    "The tool call succeeds — acceptEdits covers all tool types including MCP",
    "The tool call prompts the user for approval",
    "The tool call succeeds but only for read operations"
  ]}
  correctIdx={0}
  explanation="MCP tools require explicit `allowedTools` grants. `permissionMode: 'acceptEdits'` covers only file edits and filesystem Bash commands — it does not extend to MCP servers. To allow all tools from the db server, add `mcp__db__*` to `allowedTools`. The only permission mode that auto-approves MCP is `bypassPermissions`, which also disables all other safety checks."
/>

<KnowledgeCheck
  question="You're building an agent that uses four MCP servers with a combined total of 200 tools. You notice that context window usage is high even before the agent has called any tools. What feature should you check and what does it do?"
  options={["self-check"]}
  correctIdx={0}
  explanation="Self-check: Tool search. When enabled (the default), the SDK withholds all MCP tool definitions from the context window and loads only the tools relevant to each turn using vector similarity search over tool names and descriptions. If tool search is disabled or misconfigured, all 200 tool definitions appear in context on every turn. Verify it's enabled by checking your agent SDK configuration per the tool search docs at code.claude.com/docs/en/agent-sdk/tool-search."
/>

## What's next

In Chapter 4 you'll complete the agent's IO surface with the Files API and code execution tool. The Files API lets you upload a document once and reference it across multiple Messages calls — but the billing model is counterintuitive. The code execution tool gives your agent a Python sandbox for computation and chart generation, and the output files feed directly back into the Files API for download. Together they form the document and data layer that most production agents need.

## References

[1] Agent SDK MCP Connector — https://code.claude.com/docs/en/agent-sdk/mcp · retrieved 2026-04-30
[2] Model Context Protocol specification — https://modelcontextprotocol.io/docs/getting-started/intro · retrieved 2026-04-30
[3] MCP server registry — https://github.com/modelcontextprotocol/servers · retrieved 2026-04-30
[4] Claude Agent SDK Overview — https://code.claude.com/docs/en/agent-sdk/overview · retrieved 2026-04-30
[5] Agent Capabilities API announcement — https://claude.com/blog/agent-capabilities-api · retrieved 2026-04-30
[6] MCP OAuth 2.1 specification — https://modelcontextprotocol.io/specification/2025-03-26/basic/authorization · retrieved 2026-04-30
