---
title: Aider Local Adapter
summary: Wraps the Aider CLI so any local Ollama model can drive a Paperclip agent
---

The `aider_local` adapter spawns the [Aider](https://aider.chat) CLI as a subprocess and points it at a local [Ollama](https://ollama.com) server for inference. Aider provides the agent loop — prompt construction, tool use, file editing, git integration — so Paperclip gets a fully capable coding agent powered by whatever model you have pulled locally, with no cloud calls and no per-token cost.

## When to Use

- You want agent runs to stay on-device (no Anthropic / OpenAI / Google round-trips).
- You have a beefy enough machine to run a coding-tier local model (e.g. `qwen2.5-coder:14b`, `deepseek-coder-v2:16b`, `llama3.1:70b`).
- You want to test Paperclip workflows without burning cloud-LLM credits.

## When Not to Use

- You need top-tier reasoning quality for complex multi-step coding tasks — frontier cloud models (`claude_local`, `codex_local`) still win there.
- You want streaming token-by-token output in the UI — this adapter sets `--no-stream` to make output parsing reliable.

## Prerequisites

1. **Aider** installed and on PATH:

   ```
   pip install aider-chat
   # or
   pipx install aider-chat
   ```

2. **Ollama** running locally and a model pulled:

   ```
   ollama serve            # in one terminal
   ollama pull llama3.1:8b # in another
   ```

3. **Paperclip** running; create an agent with `Adapter type = aider_local`.

## Configuration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `model` | string | `ollama/llama3.1:8b` | Aider model id. Use `ollama/<tag>` for any model you have pulled. |
| `ollamaBaseUrl` | string | `http://localhost:11434` | Where Aider reaches Ollama. Exported as `OLLAMA_API_BASE`. |
| `editFormat` | string | (auto) | `whole`, `diff`, `udiff`, or `architect`. Aider picks per-model when omitted. |
| `promptTemplate` | string | (default) | Overrides the standard Paperclip wake prompt. |
| `maxChatHistoryTokens` | number | (Aider default) | Forwarded as `--max-chat-history-tokens`. |
| `autoCommits` | boolean | `false` | When `true`, Aider runs its own git auto-commit loop. Leave `false` if Paperclip manages git. |
| `yesAlways` | boolean | `true` | Pass `--yes-always` so Aider does not prompt interactively. |
| `restoreChatHistory` | boolean | `true` | Pass `--restore-chat-history` for multi-turn continuity. |
| `cwd` | string | `process.cwd()` | Working directory for the agent process. |
| `command` | string | `aider` | Path to the Aider binary. |
| `extraArgs` | string[] | `[]` | Additional CLI args appended after Paperclip's flags. |
| `env` | object | `{}` | KEY=VALUE env vars passed to the spawned Aider process. |
| `timeoutSec` | number | `0` (no limit) | Run timeout in seconds. |
| `graceSec` | number | `20` | SIGTERM grace period in seconds. |

## How It Works

1. Paperclip renders the wake prompt using `promptTemplate` and the run context.
2. The adapter spawns `aider --model <model> --message-file - --no-stream --no-pretty …` and pipes the rendered prompt into stdin.
3. Aider reads files in `cwd`, calls Ollama for inference, writes back any file edits, and prints a usage trailer (`Tokens: X sent, Y received. Cost: $Z`).
4. The adapter parses that trailer for token counts and returns an `AdapterExecutionResult`.

## Auth Status

Ollama is unauthenticated, so this adapter does not implement `authenticate()`. The Adapters page surfaces a `Local Ollama (N models)` badge when Ollama is reachable and at least one model is pulled, or `Local Ollama` (amber) when Ollama can't be reached. There is no Sign-in button.

## Limitations / known sharp edges

- Local model quality matters a lot. A 7B-parameter model will often loop, fail to follow tool-use instructions, or refuse to edit files. Use a coder-tuned 14B+ for non-trivial work.
- Aider's `--no-stream` makes the run feel "stuck" until inference completes — this is intentional for output parsing reliability.
- Token cost is reported in the result for parity with cloud adapters, but `costUsd` is always `0` for local Ollama models.
