---
title: OpenAI-Compatible Providers
summary: Point the codex_local and opencode_local adapters at any OpenAI-compatible endpoint using PAPERCLIP_CODEX_PROVIDERS / PAPERCLIP_OPENCODE_PROVIDERS
---

The `codex_local` and `opencode_local` adapters can talk to **any OpenAI-compatible
endpoint** — a self-hosted gateway, an internal LLM router, or a managed inference
provider — without modifying Paperclip's source. You declare the provider via an
environment variable and Paperclip injects it into the agent runtime's native config
(`config.toml` for Codex, `opencode.json` for OpenCode) at launch.

This is the supported way to run agents against providers other than the built-in
defaults. The provider definition maps 1:1 onto the underlying CLI's own provider
schema, so anything the CLI supports, you can express here.

## When to use this

- You run an OpenAI-compatible gateway or router in front of your models.
- You want to point Codex / OpenCode at a managed inference platform.
- You want the API key to stay in an environment variable and never be written to a
  tracked config file.

## Secret handling

Never put a literal API key in the provider JSON. Use a `{env:VAR}` placeholder; the
key is resolved **server-side** from the run environment at launch and baked into the
runtime config inside the (possibly sandboxed) agent home, so the secret never lands
in a tracked file.

## Codex: `PAPERCLIP_CODEX_PROVIDERS`

A JSON object that maps onto Codex's `config.toml` schema:

```jsonc
{
  "providers": {
    "<id>": {
      "name": "Display name",        // optional
      "base_url": "https://.../v1",  // OpenAI-compatible endpoint
      "env_key": "OPENAI_API_KEY",   // env var Codex reads the bearer key from
      "wire_api": "chat"             // "chat" for /chat/completions, "responses" for the Responses API
    }
  },
  "model_provider": "<id>"           // optional: select this provider at the top level
}
```

Scalar fields are emitted verbatim as TOML `key = value`; object fields
(`query_params`, `http_headers`, …) become inline tables. String values may use
`{env:VAR}` placeholders. See [Codex Local](/adapters/codex-local) for the rest of the
adapter's configuration.

## OpenCode: `PAPERCLIP_OPENCODE_PROVIDERS`

A JSON object in OpenCode's `provider` shape. OpenCode only resolves a
`--model provider/model` when that model exists in the provider's `models` map, so
list the models you intend to use explicitly:

```jsonc
{
  "<id>": {
    "npm": "@ai-sdk/openai-compatible",
    "name": "Display name",
    "options": {
      "baseURL": "https://.../v1",
      "apiKey": "{env:OPENAI_API_KEY}"
    },
    "models": {
      "vendor/model-id": {}
    }
  }
}
```

## Example: Atlas Cloud

[Atlas Cloud](https://www.atlascloud.ai/?utm_source=github&utm_medium=link&utm_campaign=paperclip)
is an OpenAI-compatible inference platform that serves DeepSeek, Qwen, GLM, Kimi,
MiniMax and other models behind a single `/v1` endpoint, which makes it a drop-in
example for these provider blocks. Set its base URL to `https://api.atlascloud.ai/v1`
and put your key in an env var.

> `deepseek-ai/deepseek-v4-pro` is a reasoning model — give it enough output budget
> (e.g. `max_tokens >= 512`), or the response can stop on length before any visible
> content is produced.

### Codex

```bash
export ATLASCLOUD_API_KEY=...   # your Atlas Cloud key
export PAPERCLIP_CODEX_PROVIDERS='{
  "providers": {
    "atlascloud": {
      "name": "Atlas Cloud",
      "base_url": "https://api.atlascloud.ai/v1",
      "env_key": "ATLASCLOUD_API_KEY",
      "wire_api": "chat"
    }
  },
  "model_provider": "atlascloud"
}'
```

Then set the agent's `model` to an Atlas model id, e.g. `deepseek-ai/deepseek-v4-pro`.

### OpenCode

```bash
export ATLASCLOUD_API_KEY=...   # your Atlas Cloud key
export PAPERCLIP_OPENCODE_PROVIDERS='{
  "atlascloud": {
    "npm": "@ai-sdk/openai-compatible",
    "name": "Atlas Cloud",
    "options": {
      "baseURL": "https://api.atlascloud.ai/v1",
      "apiKey": "{env:ATLASCLOUD_API_KEY}"
    },
    "models": {
      "deepseek-ai/deepseek-v4-pro": {}
    }
  }
}'
```

Run the agent with `--model atlascloud/deepseek-ai/deepseek-v4-pro` (or set it in the
adapter config). Add more entries to `models` for any other Atlas model you want to
route through OpenCode.

<details>
<summary>Atlas Cloud chat models (59)</summary>

- Anthropic (Claude): `anthropic/claude-haiku-4.5-20251001`, `anthropic/claude-opus-4.8`, `anthropic/claude-sonnet-4.6`
- OpenAI (GPT): `openai/gpt-5.4`, `openai/gpt-5.5`
- Google (Gemini): `google/gemini-3.1-flash-lite`, `google/gemini-3.1-pro-preview`, `google/gemini-3.5-flash`
- Alibaba (Qwen): `qwen/qwen2.5-7b-instruct`, `Qwen/Qwen3-235B-A22B-Instruct-2507`, `qwen/qwen3-235b-a22b-thinking-2507`, `qwen/qwen3-30b-a3b`, `Qwen/Qwen3-30B-A3B-Instruct-2507`, `qwen/qwen3-30b-a3b-thinking-2507`, `qwen/qwen3-32b`, `qwen/qwen3-8b`, `Qwen/Qwen3-Coder`, `qwen/qwen3-coder-next`, `qwen/qwen3-max-2026-01-23`, `Qwen/Qwen3-Next-80B-A3B-Instruct`, `Qwen/Qwen3-Next-80B-A3B-Thinking`, `Qwen/Qwen3-VL-235B-A22B-Instruct`, `qwen/qwen3-vl-235b-a22b-thinking`, `qwen/qwen3-vl-30b-a3b-instruct`, `qwen/qwen3-vl-30b-a3b-thinking`, `qwen/qwen3-vl-8b-instruct`, `qwen/qwen3.5-122b-a10b`, `qwen/qwen3.5-27b`, `qwen/qwen3.5-35b-a3b`, `qwen/qwen3.5-397b-a17b`, `qwen/qwen3.6-35b-a3b`, `qwen/qwen3.6-plus`
- DeepSeek: `deepseek-ai/deepseek-ocr`, `deepseek-ai/deepseek-r1-0528`, `deepseek-ai/DeepSeek-V3-0324`, `deepseek-ai/DeepSeek-V3.1`, `deepseek-ai/DeepSeek-V3.1-Terminus`, `deepseek-ai/deepseek-v3.2`, `deepseek-ai/DeepSeek-V3.2-Exp`, `deepseek-ai/deepseek-v4-flash`, `deepseek-ai/deepseek-v4-pro`
- Moonshot (Kimi): `moonshotai/Kimi-K2-Instruct`, `moonshotai/Kimi-K2-Instruct-0905`, `moonshotai/Kimi-K2-Thinking`, `moonshotai/kimi-k2.5`, `moonshotai/kimi-k2.6`
- Zhipu (GLM): `zai-org/GLM-4.6`, `zai-org/glm-4.7`, `zai-org/glm-5`, `zai-org/glm-5-turbo`, `zai-org/glm-5.1`, `zai-org/glm-5v-turbo`
- MiniMax: `MiniMaxAI/MiniMax-M2`, `minimaxai/minimax-m2.1`, `minimaxai/minimax-m2.5`, `minimaxai/minimax-m2.7`
- xAI (Grok): `xai/grok-4.3`
- Kuaishou (KAT): `kwaipilot/kat-coder-pro-v2`
- Other: `owl`

</details>

## Notes

- The provider id (`atlascloud` above) is arbitrary; pick whatever you like and use it
  consistently in `model_provider` / the `provider/model` model string.
- Malformed JSON or non-object provider entries are skipped and surfaced in the
  adapter's diagnostic notes rather than silently dropped.
- This mechanism configures **agent CLIs** that already speak the OpenAI-compatible
  protocol; it is not a new Paperclip adapter. To package a brand-new agent runtime,
  see [External Adapters](/adapters/external-adapters).
