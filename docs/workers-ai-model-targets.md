# Routing tasks to Cloudflare Workers AI models

Workers AI serves open-weight models on an OpenAI-compatible endpoint. Because Paperclip's adapters read `OPENAI_BASE_URL` / `OPENAI_API_KEY` from the spawned CLI's env, and the model-policy layer can select a per-agent model profile by task signals, you can route specific tasks (e.g. bulk work) to a cheap Workers AI model without code changes per company.

The reference adapter here is `cursor` (`cursor-local`). Cursor passes the configured `model` string **verbatim** to the CLI, so the curated model ids are used as **raw `@cf/...` strings with no provider wrapper**.

## One-time setup per company

1. Create a Cloudflare API token with Workers AI access; store it as a Paperclip secret (e.g. id `cloudflare-workers-ai-token`).
2. Note your Cloudflare account id; the base URL is:
   `https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1`

## Configure an agent's `bulk` runtime profile

On an agent that uses the `cursor` adapter, set a runtime model profile so the `bulk` lane targets Workers AI. In the agent's `runtimeConfig.modelProfiles.bulk.adapterConfig`:

```json
{
  "model": "@cf/moonshotai/kimi-k2.7-code",
  "env": {
    "OPENAI_BASE_URL": { "type": "plain", "value": "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1" },
    "OPENAI_API_KEY": { "type": "secret_ref", "secretId": "cloudflare-workers-ai-token" }
  }
}
```

The `model` value is the raw `@cf/...` id (Cursor forwards it verbatim — no `cloudflare/` prefix). The profile's `env` is **deep-merged** over the agent's base env (it adds/overrides `OPENAI_BASE_URL` and `OPENAI_API_KEY` while preserving the agent's other env), so the Workers AI endpoint applies only when the `bulk` profile is selected.

## Assign it with a policy rule

In `PAPERCLIP_MODEL_POLICIES` (companyId → rules), route bulk/low-priority work to the `bulk` profile:

```json
{
  "<companyId>": [
    { "when": { "workMode": ["bulk"] }, "modelProfile": "bulk", "reason": "bulk work -> Workers AI" },
    { "when": {}, "modelProfile": "cheap" }
  ]
}
```

Now a task whose work mode is `bulk` is routed to the Workers AI model; everything else falls through. An explicit per-issue model override still wins over the policy.

## Selectable Workers AI models

The `cursor` adapter exposes these curated raw `@cf/...` ids in its `models` catalog (use any as the profile's `model`):

- `@cf/moonshotai/kimi-k2.7-code` — Kimi K2.7-Code
- `@cf/zhipu/glm-5.2` — GLM-5.2
- `@cf/openai/gpt-oss-120b` — GPT-OSS-120B
- `@cf/qwen/qwen3-30b` — Qwen3-30B

## Validation notes

- Chosen adapter: cursor-local (cursor). Cursor passes the model string verbatim, so raw @cf/... ids work with no wrapper.
- Env keys: OPENAI_BASE_URL (account-scoped CF endpoint), OPENAI_API_KEY (CF API token as secret_ref).
- RESIDUAL VERIFICATION (not done in repo): whether the upstream Cursor CLI actually honors OPENAI_BASE_URL must be confirmed with one live run against an OpenAI-compatible endpoint (e.g. OpenRouter) before relying on Workers AI routing in production.
