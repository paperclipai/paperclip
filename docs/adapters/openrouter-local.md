---
title: OpenRouter Local
summary: OpenRouter API adapter setup and configuration
---

The `openrouter_local` adapter calls the [OpenRouter](https://openrouter.ai) HTTP API directly. It gives access to hundreds of models (Google Gemini, Anthropic Claude, Mistral, and more) through a single `OPENROUTER_API_KEY` — no local CLI install required. The adapter runs a full multi-step agentic loop with native function calling, skills injection, and Paperclip control-plane tool support.

## Prerequisites

- An [OpenRouter account](https://openrouter.ai) and API key
- `OPENROUTER_API_KEY` set in the server environment or per-agent config

## Configuration Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `model` | string | No | OpenRouter model ID. Defaults to `google/gemini-3.1-flash-lite-preview` |
| `apiKey` | string | No | Per-agent API key override. Falls back to `OPENROUTER_API_KEY` env var |
| `systemPrompt` | string | No | System message prepended to every request |
| `instructionsFilePath` | string | No | Path to a Markdown instructions file prepended to the system prompt |
| `promptTemplate` | string | No | Run prompt template injected as a user message on each wake |
| `bootstrapPromptTemplate` | string | No | One-time prompt for the very first run only |
| `maxTokens` | number | No | Maximum output tokens per call (default: `8192`) |
| `temperature` | number | No | Sampling temperature 0.0–2.0 (default: `0.7`) |
| `maxSteps` | number | No | Maximum agentic tool-call steps per run (default: `20`) |
| `timeoutSec` | number | No | HTTP request timeout in seconds (default: `300`) |
| `baseUrl` | string | No | Override the OpenRouter API base URL |
| `env` | object | No | Environment variables injected into the agent context (supports secret refs) |

## Model Selection

Models are tiered by cost. Use the cheapest tier that satisfies the task:

| Tier | Model ID | Cost (in / out per 1M tokens) |
|------|----------|-------------------------------|
| CHEAP | `google/gemma-4-26b-a4b-it` | $0.08 / $0.35 |
| CHEAP | `google/gemma-4-31b-it` | $0.13 / $0.38 |
| CHEAP | `minimax/minimax-m2.7` | $0.30 / $1.20 |
| MID | `google/gemini-3.1-flash-lite-preview` *(default)* | $0.25 / $1.50 |
| MID | `z-ai/glm-5.1` | $0.95 / $3.15 |
| PREMIUM ★ | `anthropic/claude-sonnet-4.6` | $3.00 / $15.00 |
| PREMIUM ★ | `google/gemini-3.1-pro-preview` | $2.00 / $12.00 |

★ PREMIUM models are reserved for manual owner configuration. Agents must not select them autonomously.

## Skills Injection

Skills are injected into the system prompt at run start. The `load_skill` tool allows agents to dynamically load additional skills by name during a run.

## Instructions Resolution

If `instructionsFilePath` is configured, Paperclip reads that file and prepends it to the system prompt on every run. New agents created with `openrouter_local` automatically receive a default `AGENTS.md` instructions bundle.

## Environment Test

Use the "Test Environment" button in the UI to validate the adapter config. It checks:

- `OPENROUTER_API_KEY` is present and non-empty
- The configured model ID is non-empty
- A live hello probe (`POST /chat/completions`) to verify API connectivity and key validity
