---
title: Custom Model Gateway
summary: Route agent model calls through an OpenAI- or Anthropic-compatible endpoint
---

Agents can send their model calls through a custom gateway. A gateway is any endpoint that speaks the OpenAI Chat Completions protocol, the OpenAI Responses protocol, or the Anthropic Messages protocol. Common gateways are LiteLLM, Ollama, vLLM, and company proxies.

Paperclip offers two ways to use a gateway:

| Path | Scope | Where you set it |
|------|-------|------------------|
| [Company AI connection](#company-ai-connection) | Every agent that uses the connection | Connectors |
| [Agent environment variables](#agent-environment-variables) | One agent | The agent form |

## Company AI connection

An AI connection can point at a custom endpoint. In Connectors, add an AI connection and pick the catalog that matches your gateway protocol:

| Catalog | Protocol | Compatible adapters |
|---------|----------|---------------------|
| Chat Completions API | `chat` | `opencode_local`, `hermes_local` |
| Responses API | `responses` | `codex_local` |
| Messages API | `messages` | `claude_local` |

Then configure the connection:

| Field | Meaning |
|-------|---------|
| Base URL | The gateway endpoint. HTTPS is required. Loopback addresses (`localhost`, `127.0.0.1`, `::1`) may use HTTP. The URL must not contain a user name, a password, query parameters, or a fragment. |
| Auth | `bearer` (default) sends the key as a bearer token. `api_key` sends the Anthropic `x-api-key` header and requires the Messages protocol. `none` sends no key. |
| Models | The model ids the gateway serves, with optional labels. The agent model field accepts these ids. |

Paperclip projects the connection into each compatible adapter:

| Adapter | What the runtime receives |
|---------|---------------------------|
| `claude_local` | `ANTHROPIC_BASE_URL`, plus `ANTHROPIC_AUTH_TOKEN` (bearer auth) or `ANTHROPIC_API_KEY` (api key auth). The selected model is pinned through the `ANTHROPIC_MODEL` variables. |
| `codex_local` | A managed Codex model provider with your base URL and `wire_api = "responses"`. The key is held in `PAPERCLIP_AI_PROVIDER_KEY`. |
| `opencode_local` | An OpenAI-compatible provider in the runtime OpenCode config. Models are addressed as `paperclip/<id>`. |
| `hermes_local` | A Hermes `config.yaml` with your base URL and `api_mode: chat_completions`. |

Select the connection on each agent, or set it as the responsible user's default. Set the agent model to one of the ids you listed.

## Agent environment variables

Each agent form has an Environment variables section. Values can be plain text or secret references. Store gateway keys as secret references. Keys that Paperclip assigns for the run, such as `PAPERCLIP_API_KEY`, cannot be overridden from agent config.

### claude_local

Claude Code reads its endpoint from environment variables:

```bash
ANTHROPIC_BASE_URL=https://gateway.example.com
ANTHROPIC_AUTH_TOKEN=<gateway-key>
```

Use `ANTHROPIC_API_KEY` instead of `ANTHROPIC_AUTH_TOKEN` when the gateway expects the `x-api-key` header. Set the agent model to an id the gateway serves.

### codex_local

Codex has no base URL environment variable. Set `PAPERCLIP_CODEX_PROVIDERS` instead. Paperclip merges it into the managed Codex `config.toml` as `[model_providers.<id>]` tables, and restores the original file after the run:

```json
{
  "providers": {
    "my-gateway": {
      "name": "My gateway",
      "base_url": "https://gateway.example.com/v1",
      "env_key": "MY_GATEWAY_KEY",
      "wire_api": "chat"
    }
  },
  "model_provider": "my-gateway"
}
```

- `env_key` names the environment variable Codex reads the key from. Set that variable on the same agent.
- `wire_api` selects the protocol Codex speaks to the provider: `chat` or `responses`.
- `model_provider` selects the active provider. The agent model picks the model within that provider.
- String values may use `{env:VAR}` placeholders. Paperclip expands them before the run starts.

Set the agent model to an id the gateway serves. You can also set `PAPERCLIP_CODEX_PROVIDERS` on the server process to apply it to all Codex agents.

### opencode_local

Set `PAPERCLIP_OPENCODE_PROVIDERS` to a JSON object in the OpenCode provider shape:

```json
{
  "my-gateway": {
    "options": {
      "baseURL": "https://gateway.example.com/v1",
      "apiKey": "{env:MY_GATEWAY_KEY}"
    },
    "models": {
      "my-model": { "name": "My model" }
    }
  }
}
```

- OpenCode resolves a model only when it is in the provider's `models` map. List every model the agent will use.
- Set the agent model to `my-gateway/my-model`.
- Set `PAPERCLIP_OPENCODE_SMALL_MODEL` to a model the gateway serves. OpenCode uses a small helper model for session titles. The run can fail when the gateway does not serve the built-in default.
- `{env:VAR}` placeholders are expanded before the run starts.

You can also set `PAPERCLIP_OPENCODE_PROVIDERS` on the server process to apply it to all OpenCode agents.

## Show gateway models in the model picker

Adapter model lists come from the CLI catalogs. Gateway models are not in those catalogs. Declare them with `PAPERCLIP_ADAPTER_MODELS` on the server process:

```json
{
  "claude_local": [{ "id": "my-model", "label": "My gateway model" }]
}
```

The object maps an adapter type to a list of `{ "id", "label" }` entries. The agent form also accepts manual model ids.

## Costs and budgets

- Usage tokens are captured for gateway runs, as for direct provider runs.
- A custom endpoint has no price by default. Paperclip does not assume provider prices for an OpenAI-compatible URL. Such receipts are marked `unpriced`.
- When the harness reports a cost itself, Paperclip uses the reported cost.
- Budget checks treat unpriced usage as a stop condition. When a budget's unpriced usage policy is not set to `allow`, an agent with unpriced events cannot start work. Plan budgets for gateway agents with this in mind. See [Costs and Budgets](/guides/board-operator/costs-and-budgets).
