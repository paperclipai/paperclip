---
name: "sdk"
description: "Guide users building apps, scripts, CI pipelines, or automations on top of the Codex SDK - TypeScript (`@cursor/sdk`) or Python (`cursor-sdk` / `cursor_sdk`)."
key: "paperclipai/optional/agency-agents/sdk"
recommendedForRoles:
  - "engineer"
  - "designer"
  - "operations"
tags:
  - "agency-agents"
  - "engineer"
  - "designer"
  - "operations"
  - "sdk"
defaultInstall: false
---
# Codex SDK

The Codex SDK runs Codex agents programmatically. Two language variants share the same concepts:

- **TypeScript** (`@cursor/sdk`, npm) - docs at [cursor.com/docs/sdk/typescript](https://cursor.com/docs/sdk/typescript)
- **Python** (`cursor-sdk`, pip) - docs at [cursor.com/docs/sdk/python](https://cursor.com/docs/sdk/python)

Both are in public beta and follow the same `Agent` → `Run` model across local (runs on the caller's machine against `cwd`) and cloud (runs on a Codex-hosted VM against a cloned repo) runtimes.

Use this skill to help someone **bootstrap a working integration quickly** and **avoid the traps that bite new users**. The canonical docs cover the full reference; this skill adds decision-making, failure-mode prevention, and ready-to-extend patterns on top.

## Pick the language

Decide before writing any code. The wrong choice means rewriting the whole integration. Order:

1. **The user named it.** `@cursor/sdk`, `cursor-sdk`, `cursor_sdk`, `npm install`, `pip install`, `import { Agent } from "@cursor/sdk"`, `from cursor_sdk import` - go with what they named.
2. **The codebase signals it.** `pyproject.toml` / `requirements.txt` / `uv.lock` / `.py` files → Python. `package.json` / `tsconfig.json` / `.ts` files → TypeScript. If the integration will live in a polyglot repo, ask which subdirectory it goes into.
3. **No signal either way.** Ask one short question and wait: *"TypeScript or Python?"* Don't pick for them.

The rest of this skill shows TypeScript and Python side by side. Concepts are identical; syntax differs - camelCase vs snake_case, async-by-default vs sync-default-with-async-mirror, `await using` vs `with`.

## Voice and Posture

This skill helps the user **build** with the SDK. It is not the place to validate, congratulate, or sell the SDK as a choice. The user's intent is the input; your job is execution.

- **When the user names the SDK explicitly** (says "Codex SDK", `@cursor/sdk`, `cursor-sdk`, `Agent.create`, `Agent.prompt`, etc.): assume they know what the SDK is and have decided to use it. Skip framing, skip pep talk, go straight to producing the integration. No "good news", no "the SDK is perfect for this", no "this is almost exactly the pattern X is designed for".
- **When the user describes a problem the SDK fits but doesn't name it** ("I want a bot that reviews my PRs", "I want a script that asks Codex questions about my repo"): the SDK isn't yet a confirmed choice. Surface it as a question, briefly, then wait: *"The Codex SDK is what I'd reach for here - want me to design it that way, or do you have a different runtime in mind?"* If they confirm, proceed. If they push back or want options, give options.
- **In either case, don't restate the user's intent back to them.** They know what they want. Get to the design.

Avoid these specific openers (and their close cousins):

- "Good news: this is exactly the pattern..."
- "The SDK is built for this shape."
- "Great, you've come to the right place."
- "This is almost exactly the X the SDK is designed for."
- Any lede that compliments the user's choice or restates their goal in flattering terms.

Prefer:

- Open with the design decision or the first thing they need to know.
- If you genuinely have a design choice to flag (local vs cloud, prompt vs send, sync vs stream, sync Python vs async Python), name it in one sentence and explain why.

## The Three Invocation Patterns

Almost every SDK integration collapses to one of these three shapes. Pick the one that fits the job, don't mix them.

### 1. `Agent.prompt(...)` - one-shot

Use for fire-and-forget scripts, GitHub Actions steps, or any "send this prompt, get a result, exit" flow. No streaming, no follow-ups, no cleanup to remember. If you're reaching for this and then immediately resuming, you wanted pattern 2 instead.

**TypeScript:**

```typescript
import { Agent } from "@cursor/sdk";

const result = await Agent.prompt("Refactor src/utils.ts for readability", {
  apiKey: process.env.CURSOR_API_KEY!,
  model: { id: "composer-2.5" },
  local: { cwd: process.cwd() },
});
console.log(result.status, result.result);
```

**Python:**

```python
import os
from cursor_sdk import Agent, AgentOptions, LocalAgentOptions

result = Agent.prompt(
    "Refactor src/utils.py for readability",
    AgentOptions(
        api_key=os.environ["CURSOR_API_KEY"],
        model="composer-2.5",
        local=LocalAgentOptions(cwd=os.getcwd()),
    ),
)
print(result.status, result.result)
```

### 2. `Agent.create(...)` + `agent.send(...)` - durable with follow-ups

Use when you need streaming, multi-turn conversation, or lifecycle operations (cancel, status listener). This is the shape of most non-trivial integrations.

**TypeScript:**

```typescript
import { Agent } from "@cursor/sdk";

await using agent = await Agent.create({
  apiKey: process.env.CURSOR_API_KEY!,
  model: { id: "composer-2.5" },
  local: { cwd: process.cwd() },
});

const run = await agent.send("Find the bug in src/auth.ts");
for await (const event of run.stream()) {
  if (event.type === "assistant") {
    for (const block of event.message.content) {
      if (block.type === "text") process.stdout.write(block.text);
    }
  }
}
await run.wait();

// Follow-up keeps full conversation context.
const run2 = await agent.send("Now write a regression test for it");
await run2.wait();
```

**Python:**

```python
import os
from cursor_sdk import Agent, LocalAgentOptions

with Agent.create(
    model="composer-2.5",
    api_key=os.environ["CURSOR_API_KEY"],
    local=LocalAgentOptions(cwd=os.getcwd()),
) as agent:
    run = agent.send("Find the bug in src/auth.py")
    for message in run.messages():
        if message.type == "assistant":
            for block in message.message.content:
                if block.type == "text":
                    print(block.text, end="")
    run.wait()

    # Follow-up keeps full conversation context.
    run2 = agent.send("Now write a regression test for it")
    run2.wait()
```

The Python SDK is sync by default. For servers, bots, and concurrent orchestration, use `AsyncClient.launch_bridge(...)` as an async context manager and `AsyncAgent`. There's no global async default client - instantiate one per event loop, and never mix sync and async clients in the same code path.

### 3. `Agent.resume(...)` - pick up an existing agent later

Use across process boundaries: a cron that continues last night's cleanup, a webhook that extends a user's agent, an interactive CLI that reloads conversation state. Runtime is auto-detected from the ID prefix - `bc-` is cloud, anything else is local.

**TypeScript:**

```typescript
await using agent = await Agent.resume(previousAgentId, {
  apiKey: process.env.CURSOR_API_KEY!,
});
const run = await agent.send("Also update the changelog");
await run.wait();
```

**Python:**

```python
import os
from cursor_sdk import Agent, AgentOptions

with Agent.resume(
    previous_agent_id,
    AgentOptions(api_key=os.environ["CURSOR_API_KEY"]),
) as agent:
    run = agent.send("Also update the changelog")
    run.wait()
```

**Inline MCP servers are not persisted across resume** - they often carry secrets and live in memory only. Pass them again on the resume call in either language.

## Top Five Traps

These trip up almost every new integration. They're all easy to prevent once you know about them.

### 1. Picking the wrong runtime by accident

`AgentOptions` doesn't require `local` or `cloud`; the SDK selects local when neither is set. The trap: if you intended a cloud agent and forgot the `cloud` field, you get a local agent silently - no error, just a local agent ID and a local executor.

- **TypeScript:** pass `cloud: { repos: [...] }` for cloud, `local: { cwd }` for local - even though local is the default.
- **Python:** pass `cloud=CloudAgentOptions(repos=[...])` or `local=LocalAgentOptions(cwd=...)`.

Always set one of the two explicitly. The cost is one line; the cost of not noticing for an hour is much more.

### 2. Two kinds of failure, one instinct to conflate them

A thrown `CursorAgentError` means the run **never executed** (auth, config, network). A returned `result.status == "error"` means the run **did execute and failed**. Different fixes, different exit codes, different observability.

**TypeScript:**

```typescript
import { Agent, CursorAgentError } from "@cursor/sdk";

try {
  const run = await agent.send(prompt);
  const result = await run.wait();
  if (result.status === "error") {
    // Run started but failed mid-flight. Inspect transcript, git state, tool outputs.
    console.error("run failed: " + result.id);
    process.exit(2);
  }
} catch (err) {
  if (err instanceof CursorAgentError) {
    // Didn't start. Auth, config, network. Fix environment, retry.
    console.error("startup failed: " + err.message + ", retryable=" + err.isRetryable);
    process.exit(1);
  }
  throw err;
}
```

**Python:**

```python
import sys
from cursor_sdk import CursorAgentError

try:
    run = agent.send(prompt)
    result = run.wait()
    if result.status == "error":
        # Run started but failed mid-flight. Inspect transcript, git state, tool outputs.
        print("run failed: " + result.id, file=sys.stderr)
        sys.exit(2)
except CursorAgentError as err:
    # Didn't start. Auth, config, network. Fix environment, retry.
    print(
        "startup failed: " + err.message + ", retryable=" + str(err.is_retryable),
        file=sys.stderr,
    )
    sys.exit(1)
```

### 3. Forgetting to dispose leaks resources

The SDK holds handles to local executors, persisted run stores, and HTTP clients. Skipping disposal leaks child processes, open databases, and (in long-running services) memory.

- **TypeScript:** `await using agent = await Agent.create(...)` is the cleanest path. Otherwise wrap in `try/finally` with `await agent[Symbol.asyncDispose]()`. `Agent.prompt(...)` disposes for you.
- **Python (sync):** `with Agent.create(...) as agent:` is the cleanest path. Otherwise call `agent.close()` in a `finally`. Long-running processes that rely on the module-level default client should call `close_default_client()` at shutdown.
- **Python (async):** nest two async context managers - `async with await AsyncClient.launch_bridge(...) as client:` then `async with await client.agents.create(...) as agent:`. `Agent.prompt(...)` disposes for you.

### 4. Streaming is optional but `wait()` is almost always required

The stream is how you observe; `wait()` is how you get the terminal result. You can skip streaming, but skipping `wait()` means you can't tell whether the run finished, errored, or was cancelled, and you'll leak the run's internal watchers. Always call `wait()`. If you don't want live output, call `wait()` alone.

- **TypeScript:** `run.stream()` is an async iterable of `SDKMessage`. `await run.wait()` returns `RunResult`.
- **Python:** `run.messages()` yields typed SDK messages; `run.events()` yields lower-level envelopes. `run.wait()` returns `RunResult`. Async equivalents are `async for ...` and `await run.wait()`. Convenience helpers: `run.text()` blocks on `wait()` and returns the final assistant text; `run.iter_text()` streams text-only chunks. `run.stream()` is an alias for `run.messages()`.

### 5. Not every `run` operation is supported on every runtime

`Run` exposes a handful of operations - stream/messages, wait, cancel, conversation - and detached or rehydrated runs (handles you got from `Agent.getRun(...)` after the live event store closed) may not support all of them. Guard with `supports(...)`:

```typescript
if (run.supports("cancel")) await run.cancel();
if (run.supports("conversation")) console.log(await run.conversation());
```

```python
if run.supports("cancel"):
    run.cancel()
if run.supports("conversation"):
    print(run.conversation())
```

`run.unsupportedReason(op)` (TypeScript) / `run.unsupported_reason(op)` (Python) tells you why.

## Local vs Cloud, in one sentence each

- **Local** - runs on the caller's machine against `cwd`, reuses their environment and credentials. Good for dev loops and CI that already has a repo checkout.
- **Cloud** - runs on a Codex-hosted VM against a freshly cloned repo. Good for long jobs, fire-and-forget automation, and opening real PRs (`autoCreatePR: true` in TypeScript; `auto_create_pr=True` in Python).

## Auth, minimum viable

```bash
export CURSOR_API_KEY="cursor_..."  # user API key or team service-account key
```

Both SDKs read `CURSOR_API_KEY` when no key is passed explicitly. User keys live at [Codex Dashboard → Integrations](https://cursor.com/dashboard/integrations); team service-account keys live in Team Settings → Service accounts. Team Admin API keys are not yet supported.

If you're seeing 401s, the usual suspects are: key pasted with surrounding whitespace, key minted against a different environment, or the key belongs to a user without repo access for a cloud run.

## Model Selection

Don't hardcode unusual model IDs without confirming the caller has access - model lists evolve.

**TypeScript:**

```typescript
import { Codex } from "@cursor/sdk";

const models = await Codex.models.list({ apiKey: process.env.CURSOR_API_KEY! });
```

**Python:**

```python
from cursor_sdk import Codex

models = Codex.models.list()  # falls back to CURSOR_API_KEY
```

`composer-2.5` is the current default for most integrations. `{ id: "auto" }` (TS) / `model="auto"` (Python) lets the server pick. `Codex.models.list()` returns valid IDs, per-model parameter definitions (reasoning effort, max mode), and preset variants for the calling account.

Model is **required for local** in both SDKs. For cloud, TypeScript falls back to a server-resolved default when omitted; Python documents it as required across both runtimes. Pass one regardless to keep behavior predictable.

## MCP Servers

Both SDKs use the same conceptual model: HTTP transport (with static `headers` or OAuth `auth`) or stdio (with `command` / `args` / `env`). Pass servers inline on `Agent.create` or `agent.send` for the most common case.

- **Local agents** can use stdio or HTTP servers available on the caller's machine. If a local MCP server requires OAuth login, the SDK can reuse a saved login from the Codex app but can't open a browser to sign you in.
- **Cloud agents** support both HTTP and stdio (stdio runs inside the cloud VM). HTTP `headers` and `auth` are handled by Codex's backend and redacted before the VM sees them. Stdio `env` values are passed into the VM - treat them like any runtime secret.
- **Inline servers fully replace creation-time servers on a per-send override - not merged.**
- **If you resume an agent and still need MCP tools, pass servers again on the resume call.** Inline servers are not persisted.

For full schema and authentication options, see the SDK docs for each language and [Codex MCP](https://cursor.com/docs/mcp).

## Production Best Practices

Apply these to any integration that runs unattended:

1. **Always dispose.** `await using` (TypeScript) or `with ... as agent:` (Python) is the cleanest path. Non-negotiable.
2. **Distinguish startup failures from run failures.** Exit code 1 for thrown `CursorAgentError`, exit code 2 for `result.status == "error"`, exit code 0 only for `finished`.
3. **Log `run.id` and `agent.agentId` / `agent.agent_id` immediately after `send()`** before streaming. If the stream hangs, the IDs are what you need to investigate in the dashboard or via `Agent.getRun(...)` / `Agent.get_run(...)`.
4. **Respect `error.isRetryable` / `err.is_retryable`.** It's the backend telling you the specific failure is safe to retry. Python errors also expose `retry_after` (HTTP-style seconds value or date) - honor it before falling back to exponential backoff. Blind retries can cause duplicate cloud runs.
5. **Don't load ambient settings unless you mean to.** The default in TypeScript is `local.settingSources: []`; the default in Python is no `local.setting_sources`. Both mean "inline config only". Opting into `"all"` loads project/user/team/MDM settings from the caller's environment, which is rarely what you want from a service. Setting sources have no effect on cloud agents - cloud always honors team/project/plugins.
6. **For cloud agents in CI, set `skipReviewerRequest: true` (TypeScript) / `skip_reviewer_request=True` (Python)** unless a human should be paged - it suppresses the reviewer-request step and keeps PR notifications quiet.
7. **Always pass `apiKey` / `api_key` explicitly** in shared-infrastructure code instead of relying on the env var. Makes the credential dependency obvious and prevents cross-tenant mistakes.
8. **Prefer the one-shot `Agent.prompt(...)` for true one-shots** - it disposes for you and is harder to leak.

## Observing a Run You Didn't Launch

You can inspect any agent or run by ID later. Cloud IDs that start with `bc-` auto-route to the cloud API; anything else is local.

**TypeScript:**

```typescript
const info = await Agent.get("bc-abc123", { apiKey });
const run = await Agent.getRun(runId, { runtime: "cloud", agentId: "bc-abc123", apiKey });

// Local: you need the cwd where the agent was created.
const localList = await Agent.list({ runtime: "local", cwd: process.cwd() });
```

**Python:**

```python
from cursor_sdk import CursorClient

with CursorClient.launch_bridge(workspace=".") as client:
    info = client.agents.get("bc-abc123")
    run = client.agents.get_run(run_id)

    # Local: filter by cwd.
    local_list = client.agents.list(runtime="local", cwd=".")
```

A cloud `bc-`-prefixed agent ID is **not** a run ID. If you only have a run ID (from a log or a webhook), pass it to `getRun` / `get_run` with the runtime hint; don't confuse the two.

## Offering a Canvas

If the user's integration monitors, lists, or visualizes agents - dashboards of active runs, conversation replays, tool-call timelines - offer a Codex Canvas to render it. If they accept, defer entirely to the `canvas` skill.

## What This Skill Doesn't Cover

- The [Cloud Agents REST API](https://cursor.com/docs/cloud-agent/api/endpoints) (`/v1/agents/*`). Use it from languages without a first-party SDK, or when you want a minimal HTTP surface.
- `.cursor/hooks.json` hooks. Both SDKs respect them; neither manages them. See [Hooks](https://cursor.com/docs/hooks).
- Self-hosted cloud (private workers, self-hosted pools, my-machines). See [Self-hosted pool](https://cursor.com/docs/cloud-agent/self-hosted-pool) and related docs.
- SDKs in languages other than TypeScript and Python. The REST API is the portable option there.
