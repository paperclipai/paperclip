---
title: MiniMax Local
summary: Direct MiniMax API adapter setup and configuration
---

The `minimax_local` adapter calls the MiniMax OpenAI-compatible chat completions API directly. It does not route MiniMax through OpenCode.

## Prerequisites

- A MiniMax API key
- A Paperclip company secret or environment binding for `MINIMAX_API_KEY`

## Configuration Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `model` | string | No | Primary MiniMax model. Defaults to `MiniMax-M3`. |
| `primaryModel` | string | No | Optional explicit override for the request model. Defaults to `model`. |
| `baseUrl` | string | No | MiniMax API base URL. Defaults to `https://api.minimax.io/v1`. |
| `temperature` | number | No | Sampling temperature. Defaults to `0.2`. |
| `max_completion_tokens` / `maxTokens` | number | No | Completion token limit. Defaults to `2048`. |
| `stripThink` | boolean | No | Strip `<think>...</think>` blocks from stored output. Defaults to `true`. |
| `cwd` / `workingDirectory` | string | No | Working-directory context used for prompt rendering and instruction resolution. |
| `instructionsFilePath` | string | No | Markdown instructions file prepended to the request prompt. |
| `promptTemplate` | string | No | Heartbeat prompt template. |
| `env.MINIMAX_API_KEY` | string / secret ref | Yes | MiniMax API credential. |
| `env.MINIMAX_API_KEY_FILE` | string | No | File path fallback containing the MiniMax API key. |

## Environment Test

Use the adapter "Test" button in the UI to validate configuration. The test checks:

- `MINIMAX_API_KEY` or `MINIMAX_API_KEY_FILE` is available
- MiniMax accepts a tiny `Reply with exactly: OK` chat completion
- The result is returned without exposing secret values

## Notes

- The built-in model list includes `MiniMax-M3`, `MiniMax-M2.7`, and `MiniMax-M2.7-highspeed`.
- By default, new MiniMax agents use the Paperclip agent workspace path pattern: `/paperclip/instances/default/workspaces/<agent-id>`.
- For the standard canary path in this fork, the UI seeds `MINIMAX_API_KEY` with secret ref `0a43cc1f-41ff-414b-b2b5-1ac3d3064ec9`.
