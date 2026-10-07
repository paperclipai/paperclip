---
title: OpenAI-compatible API
summary: Run an agent on any third-party OpenAI-compatible Chat Completions provider with an API URL, model, and key
---

The `openai_compatible` adapter runs an agent directly against any provider that exposes an OpenAI-compatible Chat Completions API — for example OpenRouter, Together, Groq, DeepSeek, Fireworks, a vLLM or LM Studio server, Ollama's `/v1` endpoint, or an internal LLM gateway. You only need three values: **API URL**, **Model**, and **API key**. No agent CLI is installed or spawned.

## How it works

Paperclip runs a tool-calling loop inside the server process against `{apiUrl}/chat/completions` (non-streaming). Each heartbeat:

1. Builds a system prompt with the agent identity, this run's `PAPERCLIP_*` values, the list of available skills, and the agent instructions bundle.
2. Sends the Paperclip wake/task prompt as a user message (appended to the stored conversation when the session is resumed).
3. Executes the tools the model calls, feeds the results back, and repeats until the model replies without tool calls or `maxTurns` is reached.
4. Saves the conversation as the task session so the next wake resumes it. History is trimmed to `maxHistoryChars`; if the provider reports a context-length error on resume, the run retries with a fresh session.

Built-in tools:

| Tool | Available | What it does |
|------|-----------|--------------|
| `paperclip_api_request` | Always | Calls the Paperclip REST API for this run. Paperclip adds the run token and `X-Paperclip-Run-Id`; only same-origin `/api/...` paths are allowed. The provider never sees the Paperclip key. |
| `load_skill` | When skills are assigned | Loads a skill's `SKILL.md` (or a file inside the skill directory) on demand. |
| `run_shell`, `read_file`, `write_file` | Only when `enableWorkspaceTools` is on and execution is local | Runs bash and edits files inside the run's workspace directory on the Paperclip host. |

The model must support tool/function calling.

## Setup

1. **Agents → New agent**, choose **OpenAI-compatible API**.
2. Enter the **API URL** (base URL such as `https://openrouter.ai/api/v1`; a full `.../chat/completions` URL is accepted and normalized).
3. Type the provider's **model** id.
4. Enter the API key in `OPENAI_COMPATIBLE_API_KEY` (or pick an organization secret). New keys are stored as organization secrets, never as plain config.
5. **Run test** sends a short chat completion (and checks `/models` when available) before you finish setup.

## Configuration Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `apiUrl` | string | Yes | Provider base URL; Paperclip calls `{apiUrl}/chat/completions` |
| `model` | string | Yes | Provider model id |
| `env.OPENAI_COMPATIBLE_API_KEY` | secret | Hosted providers | Sent as `Authorization: Bearer <key>`; local servers often need none |
| `temperature` | number | No | Sampling temperature (provider default when unset) |
| `maxTokens` | number | No | Max output tokens per response |
| `maxTurns` | number | No | Max model calls per heartbeat (default 40) |
| `requestTimeoutSec` | number | No | Per-request timeout (default 300) |
| `maxHistoryChars` | number | No | Saved conversation budget (default 120000) |
| `enableWorkspaceTools` | boolean | No | Expose shell and file tools in the workspace (default false) |
| `shellTimeoutSec` | number | No | `run_shell` timeout (default 120) |
| `cwd` | string | No | Fallback absolute workspace directory |
| `extraHeaders` | object | No | Extra provider headers (e.g. `HTTP-Referer`); `Authorization` cannot be overridden |
| `instructionsFilePath` | string | No | Agent instructions prepended to the system prompt |
| `promptTemplate` | string | No | Heartbeat prompt template |
| `bootstrapPromptTemplate` | string | No | First-run-only bootstrap prompt |

## Security notes

- `enableWorkspaceTools` lets the model run shell commands with the Paperclip server user's permissions. Enable it only for trusted providers and workspaces. The provider key is removed from the shell environment.
- The adapter runs in the server process and does not reach remote sandbox or SSH environments; workspace tools are disabled for remote execution targets.
- A plain `http://` API URL to a non-local host produces a test warning because prompts and the key travel unencrypted.

## Usage and cost

Token usage comes from the provider's `usage` block (`prompt_tokens`, `completion_tokens`, `prompt_tokens_details.cached_tokens`). Cost is not computed; the run's biller is the provider host.
