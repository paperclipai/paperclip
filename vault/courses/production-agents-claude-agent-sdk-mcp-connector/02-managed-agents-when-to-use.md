---
course_slug: production-agents-claude-agent-sdk-mcp-connector
chapter_num: 2
chapter_slug: managed-agents-when-to-use
title: "Managed Agents beta — when to use it, when to roll your own"
status: draft-for-review
author: vardaan-koenig
agent_drafted_by: course-author
date: 2026-04-30
duration_min: 45
prerequisites_chapters: [1]
learning_objectives:
  - "Describe the four core Managed Agents concepts: Agent, Environment, Session, Events"
  - "Create an agent, environment, and session via the REST API"
  - "Stream SSE events and correctly detect session.status_idle"
  - "Apply the decision rule: Managed Agents vs Agent SDK for five scenario types"
key_concepts:
  [managed-agents, agent-environment-session, sse-streaming, runtime-pricing, beta-header, status-idle]
hands_on_exercise: "Ship a Managed Agents session that runs a multi-step data analysis task and streams all tool-use events to your terminal"
sources:
  - https://platform.claude.com/docs/en/managed-agents/overview
  - https://platform.claude.com/docs/en/managed-agents/quickstart
  - https://claude.com/blog/agent-capabilities-api
---

# Managed Agents beta — when to use it, when to roll your own

Claude Managed Agents is Anthropic's fully managed REST API for running Claude as an autonomous agent inside a cloud-hosted, sandboxed environment — launched in public beta on April 8, 2026, with all endpoints requiring the `managed-agents-2026-04-01` beta header.

On the same day the Claude Code SDK was renamed, Anthropic shipped this hosted counterpart. Where the [[course/production-agents-claude-agent-sdk-mcp-connector/01-sdk-rename-what-changed|Agent SDK]] runs the agent loop inside your own process, Managed Agents runs it inside Anthropic's infrastructure. Your application becomes an event producer and consumer: you send user messages, you stream back results. Anthropic handles the container, the tool execution, the session persistence, and the compute [1]. The pricing reflects this: $0.08 per runtime hour plus standard Claude model usage, meaning an agent running 24/7 costs roughly $58 per month in infrastructure before a single token is billed [2].

> **Prerequisites**: Chapter 1 (Claude Agent SDK installed and one successful `query()` call completed)
>
> **Time**: 45 minutes
>
> **Learning objectives**: By the end of this chapter you can create a Managed Agents session, stream its events, detect completion, and choose correctly between Managed Agents and Agent SDK for a given workload.

## Key facts

1. Claude Managed Agents launched in public beta on April 8, 2026; all API requests require the `managed-agents-2026-04-01` beta header [1].
2. Pricing: $0.08 per runtime hour + standard Claude model token costs; the runtime clock runs from session creation to session termination [2].
3. Rate limits: 300 requests per minute for create endpoints (agents, sessions, environments); 600 requests per minute for read endpoints (retrieve, list, stream) [1].
4. The `agent_toolset_20260401` tool type enables the full built-in toolset: Bash, file operations, web search and fetch, and MCP servers [1].
5. Two features — outcomes and multiagent — are in research preview and require separate access approval [1].
6. Session state (event history) is persisted server-side by Anthropic, not on your filesystem [1].

## The four core concepts

Managed Agents introduces four concepts that don't exist in the Agent SDK. You need to understand all four before writing a single line of code.

**Agent** — a saved configuration: model, system prompt, tools, MCP servers, and skills. Create it once, reference it by `agent.id` across every session you start. Think of it as a Docker image: you build it, then run containers from it.

**Environment** — a cloud container template: pre-installed packages, network access rules, and mounted files. Today the only supported config type is `cloud` with `unrestricted` or `restricted` networking. The environment determines what's in the sandbox; the agent determines what thinks.

**Session** — a running instance of an agent inside an environment. One session = one task. Sessions are not reused. When the task is done, the session goes idle and you start a new one for the next task.

**Events** — the messages flowing between your application and the running session. You send `user.message` events; the agent emits `agent.message`, `agent.tool_use`, and eventually `session.status_idle` events back over SSE.

## Creating your first agent

Install the Anthropic SDK (not the Agent SDK — Managed Agents uses the standard Anthropic client):

```bash
pip install anthropic  # Python
npm install @anthropic-ai/sdk  # TypeScript
```

Create an agent. This is a one-time operation — save the returned `agent.id`:

```python
from anthropic import Anthropic

client = Anthropic()  # reads ANTHROPIC_API_KEY from env

agent = client.beta.agents.create(
    name="Data Analyst",
    model="claude-opus-4-7",
    system="You are a data analyst. When given a dataset, summarize it with statistics and key insights.",
    tools=[
        {"type": "agent_toolset_20260401"},  # enables Bash, file ops, web search
    ],
)

print(f"Agent ID: {agent.id}")  # save this
print(f"Agent version: {agent.version}")
```

```typescript
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

const agent = await client.beta.agents.create({
  name: "Data Analyst",
  model: "claude-opus-4-7",
  system: "You are a data analyst. When given a dataset, summarize it with statistics and key insights.",
  tools: [{ type: "agent_toolset_20260401" }],
});

console.log(`Agent ID: ${agent.id}`);
```

<Callout type="info">
The `agent_toolset_20260401` tool type is a bundle — it's not equivalent to listing individual tools. It enables everything Managed Agents supports including Bash, file I/O, web search/fetch, and MCP. If you need to restrict to specific tools, configure them individually rather than using the toolset bundle.
</Callout>

## Creating an environment

```python
environment = client.beta.environments.create(
    name="analyst-env",
    config={
        "type": "cloud",
        "networking": {"type": "unrestricted"},  # allows outbound web access
    },
)

print(f"Environment ID: {environment.id}")  # save this too
```

The environment is also a one-time setup. For most workloads, `unrestricted` networking is correct — your agent can fetch URLs, call APIs, and pull packages. For sensitive data processing, use `restricted` to block outbound access.

## Starting a session and streaming events

This is where Managed Agents gets interesting. The pattern is: open a stream, then immediately send the first user message. Events arrive in real time via SSE:

```python
import asyncio
from anthropic import Anthropic

client = Anthropic()

# Create session (reuse agent_id and environment_id from above)
session = client.beta.sessions.create(
    agent=agent_id,
    environment_id=environment_id,
    title="Analyze Q1 sales data",
)

# Open SSE stream + send first message
with client.beta.sessions.events.stream(session.id) as stream:
    client.beta.sessions.events.send(
        session.id,
        events=[{
            "type": "user.message",
            "content": [{
                "type": "text",
                "text": "Here is some sales data as a Python list: [120, 340, 290, 410, 380]. Compute mean, median, and standard deviation. Show your work in Python code."
            }]
        }],
    )

    for event in stream:
        match event.type:
            case "agent.message":
                for block in event.content:
                    print(block.text, end="", flush=True)
            case "agent.tool_use":
                print(f"\n[Tool: {event.name}]", flush=True)
            case "session.status_idle":
                print("\n\n[Session complete]")
                break
```

```typescript
const session = await client.beta.sessions.create({
  agent: agentId,
  environment_id: environmentId,
  title: "Analyze Q1 sales data",
});

const stream = await client.beta.sessions.events.stream(session.id);

await client.beta.sessions.events.send(session.id, {
  events: [{
    type: "user.message",
    content: [{
      type: "text",
      text: "Sales data: [120, 340, 290, 410, 380]. Compute mean, median, std dev. Show Python code."
    }]
  }]
});

for await (const event of stream) {
  if (event.type === "agent.message") {
    for (const block of event.content) process.stdout.write(block.text);
  } else if (event.type === "agent.tool_use") {
    console.log(`\n[Tool: ${event.name}]`);
  } else if (event.type === "session.status_idle") {
    console.log("\n[Session complete]");
    break;
  }
}
```

<RunPromptCell
  model="claude-opus-4-7"
  prompt="You are running inside a Managed Agents session. The user has sent: 'Here is some sales data as a Python list: [120, 340, 290, 410, 380]. Compute mean, median, and standard deviation. Show your work in Python code.' Run the computation using the Bash tool."
  expectedOutput="Claude emits an agent.message with a plan, then an agent.tool_use event for Bash, then another agent.message with results like: mean=308.0, median=340.0, std_dev=109.3. The session then emits session.status_idle."
/>

## The pricing trap most tutorials skip

Here's the fact the quickstart buries: the $0.08 per runtime hour accrues from session creation to session termination — not from when the agent is actively processing. A session waiting for a user message, sleeping between tool calls, or paused after going idle but not explicitly closed still accrues runtime cost.

The operational implication:

- **Short, stateless tasks** (under 5 minutes): Managed Agents is fine. The $0.08/hr works out to ~$0.007 per run.
- **Long interactive sessions** (hours with gaps): runtime cost compounds fast. An agent session left open for 8 hours waiting for user input = $0.64 in runtime before tokens.
- **Polling loops** ("check every 30 minutes"): never use Managed Agents for this. Use the Agent SDK with a cron job.

Always close idle sessions explicitly:

```python
client.beta.sessions.update(session.id, status="completed")
```

## Decision rule: Managed Agents vs Agent SDK

Apply this five-scenario decision table:

| Scenario | Use |
|---|---|
| Long-running task (>5 min), async, need cloud sandbox | **Managed Agents** |
| Agent needs to operate on files on your own server/filesystem | **Agent SDK** |
| You need custom in-process tool execution (Python functions) | **Agent SDK** |
| You're prototyping locally; no cloud infra budget yet | **Agent SDK** |
| You need to serve many concurrent agent sessions to end users | **Managed Agents** (they handle the infrastructure) |

The canonical migration path Anthropic documents is: prototype locally with the Agent SDK, then move to Managed Agents for production. But that path only makes sense if your production workload is long-running and async. If your agents run in 30-second bursts triggered by webhooks, the Agent SDK on a serverless function is cheaper and simpler.

<Callout type="hot">
Managed Agents is in public beta as of April 2026. The `managed-agents-2026-04-01` beta header is required on every request. Behaviors can be refined between releases. Two capabilities — outcomes and multiagent — are in research preview and require a separate access request at `claude.com/form/claude-managed-agents`. Do not build production features that depend on research-preview capabilities without direct Anthropic support.
</Callout>

## Steering a session mid-execution

You can send additional user events to a running session to change direction without starting a new session:

```python
# Session is running; you want to narrow the scope
client.beta.sessions.events.send(
    session.id,
    events=[{
        "type": "user.message",
        "content": [{"type": "text", "text": "Focus only on the top 3 products by revenue."}]
    }]
)
```

This is one of the most powerful Managed Agents features and the clearest difference from the Agent SDK: the agent is running remotely, and you can inject new instructions while it works. With the Agent SDK, you'd need to stop the generator and restart with a new prompt.

<RunPromptCell
  model="claude-opus-4-7"
  prompt="Walk me through the Managed Agents session lifecycle: from agent creation through session completion. List each API call in order and what state change it produces."
  expectedOutput="Claude describes: (1) POST /v1/agents → returns agent.id; (2) POST /v1/environments → returns environment.id; (3) POST /v1/sessions with agent + environment_id → returns session.id in status 'created'; (4) GET /v1/sessions/{id}/stream (SSE) → stream opens; (5) POST /v1/sessions/{id}/events with user.message → agent begins work, emits agent.message and agent.tool_use events; (6) session.status_idle event signals completion."
/>

## Hands-on exercise

**Ship a Managed Agents session that runs a multi-step data analysis task and streams all tool-use events to your terminal.**

Steps:
1. Create an agent with `model: "claude-opus-4-7"` and `tools: [{ type: "agent_toolset_20260401" }]`
2. Create an environment with `type: "cloud"` and `networking: { type: "unrestricted" }`
3. Create a session referencing both
4. Send this user message: "Write a Python script that fetches the JSON from https://jsonplaceholder.typicode.com/todos (limit to 10 items), filters only completed todos, and prints each title. Run it."
5. Stream events and print: the tool name for every `agent.tool_use` event, and the text for every `agent.message` event

**Verification**: You see at least one `[Tool: bash]` line in your terminal output followed by the actual output of the Python script, ending with `[Session complete]`.

**Estimated time**: 20 minutes

<KnowledgeCheck
  question="A team is building an AI coding assistant that responds to GitHub webhook events. Each request takes 15–30 seconds. The team is choosing between Managed Agents and Agent SDK. Which is more appropriate, and why?"
  options={[
    "Agent SDK — short, stateless, webhook-triggered tasks don't benefit from Managed Agents' hosted runtime, and per-invocation costs are lower",
    "Managed Agents — it scales automatically to handle concurrent GitHub events",
    "Managed Agents — it includes a built-in GitHub webhook listener",
    "Agent SDK — the Managed Agents beta header makes it unsuitable for production webhooks"
  ]}
  correctIdx={0}
  explanation="For 15–30 second tasks triggered by webhooks, the Agent SDK on a serverless function (Lambda, Cloud Run) is the right call. Managed Agents charges $0.08/hr from session creation, meaning each short task costs the same as a task left running for an hour. The beta header caveat is real but not the primary reason — the cost and architecture fit is."
/>

<KnowledgeCheck
  question="You've created a Managed Agents session and opened the SSE stream. What event type signals that the agent has finished working and your application should stop listening?"
  options={["self-check"]}
  correctIdx={0}
  explanation="Self-check: The event type is `session.status_idle`. When you see this event in your stream loop, break out of the loop and optionally close the session with `client.beta.sessions.update(session.id, status='completed')`. Not breaking the loop means your stream stays open and the session continues accruing runtime cost."
/>

## Fetching historical event data

One significant advantage of Managed Agents over the Agent SDK: event history is persisted server-side. If your stream disconnects mid-session, you don't lose the work. You can replay the full event log from the API:

```python
# Reconnect and fetch the full history of what happened
events = client.beta.sessions.events.list(session_id)

for event in events.data:
    print(f"{event.type}: {event}")
```

This is fundamentally different from the Agent SDK's JSONL session files, which live on your local filesystem. For Managed Agents, the source of truth is Anthropic's infrastructure, which means:
- Network partitions don't corrupt the session
- You can inspect completed sessions retroactively (e.g., for debugging or billing audit)
- Multiple processes can query the same session's history

The trade-off is that you're locked into Anthropic's event retention policy, not your own. Keep this in mind for compliance-sensitive workloads.

## Multi-agent sessions (research preview)

The most ambitious Managed Agents capability is multiagent: running multiple coordinated agents as a single session. As of April 2026, this is in research preview and requires a separate access request at `claude.com/form/claude-managed-agents`.

The pattern is: one orchestrator agent breaks the task, one or more worker agents execute subtasks, results flow back to the orchestrator. Each agent runs in its own environment container. This is architecturally equivalent to what the [[course/production-agents-claude-agent-sdk-mcp-connector/01-sdk-rename-what-changed|Agent SDK's subagent feature]] provides in-process, but fully hosted.

If you're building workflows that require true parallelism (multiple agents running simultaneously rather than sequentially) and don't want to manage the orchestration infrastructure yourself, the multiagent research preview is worth requesting access to.

## Rate limits in practice

The rate limits deserve more attention than the documentation gives them. At 300 create requests per minute for agents, environments, and sessions — shared across those three endpoints — a system that spins up one session per user request could easily hit this ceiling at modest traffic:

- 300 requests / minute = 5 requests / second
- A web app with 100 concurrent users each triggering one session: you're at 100 create RPM on session creation alone, leaving headroom for 200 agent/environment creates per minute

In practice, **pre-create your agents and environments once** and reuse their IDs. The agent and environment IDs are stable — you don't need to recreate them for each session. Only the session is per-task:

```python
# Create once, store these IDs
AGENT_ID = "agt_01XxXxxXx"       # created once, reused forever
ENVIRONMENT_ID = "env_01YyYyyYy"  # created once, reused forever

# Create per-task
async def handle_user_request(task: str) -> str:
    session = client.beta.sessions.create(
        agent=AGENT_ID,           # reused
        environment_id=ENVIRONMENT_ID,  # reused
        title=task[:100],
    )
    # ... stream events
```

With this pattern, you're only consuming session create capacity (300 RPM total, mostly sessions if agents and environments are already created), not burning agent and environment creates on every request.

## What's next

In Chapter 3 you'll connect external tools to your agent via the Model Context Protocol. MCP is what turns a general-purpose Claude into a specialized agent that can query your database, interact with GitHub, and call internal APIs — all without you writing custom tool implementations. The connector has three transport modes, and choosing the wrong one for a given server is the most common setup mistake.

## References

[1] Claude Managed Agents Overview — https://platform.claude.com/docs/en/managed-agents/overview · retrieved 2026-04-30
[2] Claude Managed Agents Quickstart — https://platform.claude.com/docs/en/managed-agents/quickstart · retrieved 2026-04-30
[3] Agent Capabilities API announcement — https://claude.com/blog/agent-capabilities-api · retrieved 2026-04-30
[4] Claude Managed Agents Community Guide — https://blog.laozhang.ai/en/posts/claude-managed-agents · retrieved 2026-04-30
[5] Claude Agent SDK Overview — https://code.claude.com/docs/en/agent-sdk/overview · retrieved 2026-04-30
