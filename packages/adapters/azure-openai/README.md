# @paperclipai/adapter-azure-openai

Paperclip adapter for **Azure OpenAI** and **Azure AI Foundry** serverless deployments.

Wraps Azure's OpenAI-compatible `/chat/completions` endpoint with SSE streaming, real-time delta forwarding, and honest usage/cost reporting for Paperclip's budget system.

## Two installation paths

| | Built-in (this repo) | External plugin |
|---|---|---|
| Registered in | `server/src/adapters/registry.ts` | `paperclipai plugin install @paperclipai/adapter-azure-openai` |
| Distribution | Ships with Paperclip | Installed independently from npm |
| Update cadence | Paperclip release | Independent semver |

Both paths use the same `createServerAdapter()` factory exported from `./src/index.ts`.

## Adapter type

`azure_openai` — covers both classic Azure OpenAI resource deployments and Azure AI Foundry serverless model endpoints. The `deploymentKind` config field picks the request shape:

- `azure_openai` → `POST {endpoint}/openai/deployments/{deployment}/chat/completions?api-version={ver}`
- `azure_ai_foundry` → `POST {endpoint}/chat/completions`

Auth is `api-key: {key}` for both.

## Configuration

See `src/server/config-schema.ts` for the full field list. Minimum required:

- `endpoint` — Azure resource URL or Foundry inference URL
- `apiKey` — stored as a Paperclip secret
- `deployment` — required for `deploymentKind='azure_openai'`

Optional: `apiVersion`, `deploymentKind`, `systemPrompt`, `temperature`, `maxOutputTokens`, `timeoutSec`, `headers`.

## Cost tracking

`src/server/pricing.ts` carries a hand-maintained USD/1M-token table for the current GPT-4o and o-series families. Deployments whose model can't be resolved report `costUsd: null` — Paperclip still accumulates token counts, so unknown models surface as "tokens tracked, cost unknown" rather than silently reading as $0 against the budget hard-stop.

Billing type reported: `metered_api` (Azure pay-as-you-go).

## Session model

Azure OpenAI is stateless per request. There is no server-side session to resume; Paperclip's normal wake-payload machinery (task history, recovery envelopes, plan review) is rendered into the prompt on every heartbeat via `renderPaperclipWakePrompt()`.

## Non-goals

- **Local tool use / shell / filesystem.** Use a CLI adapter (`claude_local`, `codex_local`, `hermes_local`) and point its provider at Azure at the CLI layer if you need agentic tools.
- **GitHub Copilot subscription auth.** Separate adapter — see the roadmap.
- **Azure AD bearer auth.** The current implementation sends `api-key`; AAD bearer support is planned as a follow-up (operators can inject `Authorization: Bearer …` via the `headers` field today).

## Development

```
pnpm --filter @paperclipai/adapter-azure-openai typecheck
pnpm --filter @paperclipai/adapter-azure-openai test
```
