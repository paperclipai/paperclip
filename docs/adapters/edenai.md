---
title: Eden AI
summary: Use Eden AI as the LLM gateway behind a Paperclip adapter
---

[Eden AI](https://www.edenai.co) is an LLM gateway that exposes OpenAI-compatible `/chat/completions` (plus `/messages`, `/embeddings`, `/audio/*`, `/image/*`, `/moderations`) and routes those calls to underlying providers (OpenAI, Anthropic, Google, Mistral, and others). It is not a Paperclip adapter and does not need its own `packages/adapters/edenai-*/` entry. Eden AI is a backend that an existing adapter can target.

This page documents how Eden AI works behind Paperclip's adapters today.

## Adapter compatibility

| Adapter | Works with Eden AI? | Setup |
| --- | --- | --- |
| `opencode_local` | Yes. Configure a custom `edenai` provider in your global OpenCode config, then select an `edenai/...` model in the agent. | [See below](#opencode_local) |
| `hermes_local` (external plugin) | Indirect. Hermes added Eden AI as a provider upstream; `hermes_local` (npm: `@henkey/hermes-paperclip-adapter`) wraps the Hermes CLI, so the path works through it. Not exercised by this PR. | [See below](#hermes_local) |
| `claude_local`, `codex_local`, `gemini_local` | Not directly. These CLIs target a single provider's API and do not support OpenAI-compatible custom backends. | (n/a) |

## Why this is a docs page, not a new adapter

Paperclip adapters wrap agent runtimes (Claude Code, Codex, OpenCode, and similar). Eden AI is a provider gateway, not an agent. Adding a new adapter for Eden AI would mean writing a fresh agent loop on top of `/chat/completions`, which is outside the scope of this integration. The simpler and correct shape is to use an existing multi-provider adapter and point it at Eden AI.

## Setup

### opencode_local

OpenCode (the agent runtime Paperclip wraps in `opencode_local`) reads its provider list from a static config file at `~/.config/opencode/opencode.json`. It does not auto-discover Eden AI's catalog from `/v3/models` at runtime. Before Paperclip's picker shows any `edenai/...` route, OpenCode needs to know each id you want to use. A single command registers Eden AI's entire live catalog (around 350 models) so you never have to hand-edit JSON.

#### Quick setup (recommended)

Run once per machine. Installs OpenCode if missing, then writes `~/.config/opencode/opencode.json` with every model Eden AI offers right now (around 350 entries across Anthropic, OpenAI, Google, Mistral, Kimi, Grok, DeepSeek, Bedrock, Cohere, and others):

```bash
# Prereqs: Node 18+, jq, an EDENAI_API_KEY in your env.
: "${EDENAI_API_KEY:?Error: EDENAI_API_KEY is not set. Export it before running this script.}"

npm install -g opencode-ai
mkdir -p ~/.config/opencode

# Back up any existing config before refreshing.
[ -f ~/.config/opencode/opencode.json ] && \
  cp ~/.config/opencode/opencode.json \
     ~/.config/opencode/opencode.json.bak.$(date +%Y%m%d-%H%M%S)

# Deep-merge Eden AI's live catalog into the existing config. Other
# providers and unrelated top-level keys are preserved; provider.edenai
# is added or refreshed. The `// {}` guard turns an empty/erroring
# catalog response into an empty (but valid) models map instead of
# writing `"models": null`, which OpenCode would reject.
EXISTING=$(cat ~/.config/opencode/opencode.json 2>/dev/null || echo '{}')
curl -fsS https://api.edenai.run/v3/models \
  -H "Authorization: Bearer $EDENAI_API_KEY" \
  | jq --argjson existing "$EXISTING" '
      $existing * {
        "$schema": "https://opencode.ai/config.json",
        provider: {
          edenai: {
            name: "Eden AI",
            npm: "@ai-sdk/openai-compatible",
            options: {
              baseURL: "https://api.edenai.run/v3",
              apiKey: "{env:EDENAI_API_KEY}"
            },
            models: ([.data[].id] | map({(.): {name: ("Eden AI -> " + .)}}) | add // {})
          }
        }
      }
    ' > ~/.config/opencode/opencode.json.new \
  && mv ~/.config/opencode/opencode.json.new ~/.config/opencode/opencode.json
```

The script is non-destructive:

- An existing `~/.config/opencode/opencode.json` is copied to `opencode.json.bak.<timestamp>` before any change. If anything goes wrong, restore with `mv ~/.config/opencode/opencode.json.bak.<timestamp> ~/.config/opencode/opencode.json`.
- The `jq --argjson existing "$EXISTING" '$existing * {...}'` does a deep merge: any other providers you've registered (`provider.openai`, `provider.anthropic`, a custom Hermes block, etc.) are preserved; only the `edenai` provider is added or refreshed.
- The output is written to a temp file (`opencode.json.new`) and only renamed on success, so a partial jq failure cannot leave a half-written config in place.

Set `EDENAI_API_KEY` in the environment Paperclip runs under, or in the agent's `adapterConfig.env` so it survives across `pnpm dev` restarts. The `{env:EDENAI_API_KEY}` placeholder is resolved by OpenCode at spawn time from whatever env it inherits. Restart `pnpm dev`, refresh the UI, and Paperclip's model picker will list every Eden AI route.

To refresh later (when Eden AI adds or removes models), re-run the same command.

#### Manual setup (curated subset)

If you would rather hand-pick a smaller list (for example, to limit cost exposure or to keep the picker focused), write `~/.config/opencode/opencode.json` directly with just the ids you want:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "edenai": {
      "name": "Eden AI",
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "https://api.edenai.run/v3",
        "apiKey": "{env:EDENAI_API_KEY}"
      },
      "models": {
        "anthropic/claude-opus-4-7": { "name": "Eden AI Claude Opus 4.7" },
        "openai/gpt-5": { "name": "Eden AI OpenAI gpt-5" },
        "google/gemini-2.5-pro": { "name": "Eden AI Gemini 2.5 Pro" }
      }
    }
  }
}
```

Paperclip's `opencode_local` adapter sets `OPENCODE_DISABLE_PROJECT_CONFIG=true`, so per-project `opencode.json` files are ignored. Configure the provider globally only.

#### How model selection works in Paperclip

Once OpenCode is set up, in any `opencode_local` agent's `adapterConfig`:

```json
{ "model": "edenai/openai/gpt-4o-mini" }
```

The Paperclip model picker is live-discovered from OpenCode, not curated. `listOpenCodeModels()` runs `opencode models` on the host and returns every model the user registered in OpenCode's global config (see [server/src/adapters/registry.ts:595](https://github.com/paperclipai/paperclip/blob/master/server/src/adapters/registry.ts#L595), where `listAdapterModels` prefers `listModels()` over any static fallback). Whatever you put in `provider.edenai.models` shows up in Paperclip's UI automatically.

`packages/adapters/opencode-local/src/index.ts` ships a 12-entry static fallback (Anthropic Opus 4.7/4.6, Sonnet 4.6/4.5, Haiku 4.5; OpenAI gpt-5/-mini, gpt-4o/-mini; Google gemini-2.5-pro/-flash, 2.0-flash-001). It is only displayed when `opencode models` discovery returns zero, typically when OpenCode CLI is not installed yet. With OpenCode installed and configured (either path above), the picker shows whatever live discovery returns.

### hermes_local

Eden AI was added as a first-class provider in the Hermes CLI in a separate upstream integration. With Hermes installed and the `hermes_local` adapter plugin available (external plugin: `@henkey/hermes-paperclip-adapter`), Hermes-side configuration of `--provider edenai --model edenai/<model>` flows through the plugin unchanged, so no paperclip-side change is required.

This path is not exercised by the present PR, which only edits paperclip's tree (`opencode_local`, `.env.example`, docs). Verify the Hermes-side setup against `@henkey/hermes-paperclip-adapter` and your installed Hermes version before relying on it; paperclip cannot guarantee compatibility with an external plugin's behavior.

## Verified compatibility

Eden AI's OpenAI-compatible surface has been validated end-to-end on two prior hosts (LiteLLM and Hermes). The compatibility matrix from those runs lives in the integration agent's examples directory and applies here verbatim. Eden AI is host-agnostic.

| Capability | Status | Evidence |
| --- | --- | --- |
| `/chat/completions` (OpenAI-compatible request and response shape) | Pass | `edenai-on-hermes/compatibility-matrix.md` |
| Streaming | Pass | same |
| Tool / function calling | Pass | same |
| Embeddings | Pass | same |
| JSON mode | Pass | same |
| Long context | Pass | same |
| Error shape (OpenAI-style) | Pass | same |
| Rate-limit headers | Pass | same |
| Model id format (`provider/model`) | Pass | same |

## If a model you want is not in the picker

Eden AI exposes roughly 350 models live across a dozen providers (OpenAI, Anthropic, Google, Mistral, Cohere, Amazon Bedrock, xAI Grok, DeepSeek, Moonshot/Kimi, and others). The Quick setup in the previous section registers all of them in one command, so this should rarely be an issue. If it is, three options:

| Option | When | How |
| --- | --- | --- |
| Re-run Quick setup | Eden AI added a new model since you set up | Re-run the `curl ... \| jq ...` block in [Quick setup](#quick-setup-recommended). It overwrites `~/.config/opencode/opencode.json` with the latest catalog. |
| Append a single id | You manually wrote a curated config and need to add one model | Edit `~/.config/opencode/opencode.json`, add `"<provider>/<id>": { "name": "..." }` under `provider.edenai.models`, restart `pnpm dev`. |
| Type the id directly | One-off use without changing config | The agent's `model` field accepts any `provider/model` string. Paperclip's `requireOpenCodeModelId` ([packages/adapters/opencode-local/src/server/models.ts](https://github.com/paperclipai/paperclip/blob/master/packages/adapters/opencode-local/src/server/models.ts)) only checks shape, not membership in the picker. The call still goes through if OpenCode resolves the id. |

To browse the live catalog and find a specific id:

```bash
curl -fsS https://api.edenai.run/v3/models \
  -H "Authorization: Bearer $EDENAI_API_KEY" \
  | jq -r '.data[].id' | grep -i kimi    # or any keyword
```

## What this integration does not cover

This integration uses Eden AI as a chat-completions backend behind `opencode_local` (and, by extension, `hermes_local` once that plugin is installed). It does not touch Eden AI's other endpoints, because Paperclip has no agent surface that calls them today:

| Eden AI endpoint | Used by this integration? | Why |
| --- | --- | --- |
| `/chat/completions` | Yes | OpenCode's agent loop calls it; this is the integration. |
| `/messages` (Anthropic-style) | No | OpenCode normalises everything to OpenAI-compatible /chat/completions internally. |
| `/embeddings` | No | No paperclip adapter currently calls embeddings. |
| `/image/generations` | No | Paperclip has no image-generation adapter. Building one would be a new feature contribution (see CONTRIBUTING.md Path 2). |
| `/audio/transcriptions`, `/audio/speech` | No | Paperclip has no audio adapter. Same scope note as image. |
| `/moderations` | No | Paperclip's content path does not call moderation. |

If you need image generation or audio, the right path is to either build a dedicated paperclip adapter (coordinate in Discord first, per `CONTRIBUTING.md`) or call Eden AI's REST API directly from your own service. This integration is about wiring Eden AI into the existing chat-agent flow, not about expanding paperclip's surface.

Eden AI does not implement `/batches` or `/rerank`, but no paperclip adapter uses those either, so there is no impact.

## Other notes

- **Multi-slash model ids**. Eden AI ids contain a slash (`openai/gpt-4o-mini`), so prefixed with the OpenCode provider name they become `edenai/openai/gpt-4o-mini` (two slashes total). OpenCode's model resolver accepts this shape (the validator in `packages/adapters/opencode-local/src/server/models.ts:requireOpenCodeModelId` only requires at least one slash with non-empty parts on both sides). Verify model availability with `opencode models` after configuring the provider before assuming it works for a given Eden AI route.
- **API key flow**. The `apiKey` value `{env:EDENAI_API_KEY}` in OpenCode's config is resolved by OpenCode at spawn time from whatever env it inherits. Set `EDENAI_API_KEY` in the agent's `adapterConfig.env` (most reliable across `pnpm dev` restarts) or in the shell that started Paperclip.
- **Per-model capabilities and quotas**. Eden AI is a passthrough; each underlying model keeps its own capability matrix (max output tokens, whether tool use is supported in streaming mode, context window, supported message roles, and so on). OpenCode's "Test environment" hello probe enables both streaming and tool calling, which works on flagship routes (Anthropic Opus/Sonnet/Haiku 4.x, OpenAI gpt-5 / gpt-4o family, Google Gemini 2.5 Pro/Flash, Mistral Large) but can fail on some older or Bedrock-routed budget models with errors like `max tokens exceeds 4096` or `doesn't support tool use in streaming mode`. For any specific model you intend to use, check [Eden AI's documentation](https://docs.edenai.co) for that route's capability list. The integration itself is fine; the limit lives in the upstream model, not in paperclip or OpenCode.

## See also

- [Adapters overview](/adapters/overview)
- [External adapters](/adapters/external-adapters)
- [Eden AI docs](https://docs.edenai.co)
