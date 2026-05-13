# KiloCode Gateway Adapter

`@paperclipai/adapter-kilocode-gateway` connects Paperclip to the [KiloCode Gateway](https://kilo.ai) — an OpenAI-compatible HTTP API that routes requests to multiple AI providers (Anthropic, OpenAI, Google, DeepSeek).

## Transport

HTTP POST to `/api/gateway/chat/completions` with Bearer auth and optional SSE streaming.

## Auth

Set `adapterConfig.apiKey` or the `KILO_API_KEY` environment variable.

## Model Discovery

Models are fetched dynamically from `GET https://api.kilo.ai/api/gateway/models` with a 60-second TTL cache. Static fallback models are used when the endpoint is unreachable.

## Configuration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `apiKey` | string | — | KiloCode Bearer API token |
| `model` | string | — | Model ID (e.g. `anthropic/claude-sonnet-4.5`) |
| `baseUrl` | string | `https://api.kilo.ai/api/gateway` | Gateway base URL |
| `temperature` | number | `0.7` | Sampling temperature |
| `maxTokens` | number | `8192` | Max tokens in completion |
| `stream` | boolean | `true` | Enable SSE streaming |
| `timeoutSec` | number | `120` | Request timeout in seconds |
