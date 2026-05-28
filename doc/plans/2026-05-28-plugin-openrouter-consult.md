# OpenRouter Consult — Tool Plugin Plan

**Status:** Proposed — scaffolded as plan only on 2026-05-28. No code yet.
**Owner:** ValAdrien.DEV
**Scope:** Ship a `plugin-openrouter-consult` tool plugin that exposes a single `consult_model` tool to agents, letting them route a one-shot question to any OpenRouter-listed model without changing the agent's own runtime.

## Why a tool, not an adapter

- The agent's runtime stays whatever it is (`claude_local`, `perplexity_agent`, etc.). OpenRouter is invoked **only** when the agent decides "I want a second opinion from Llama 3.1 / Mistral / DeepSeek / etc."
- One key (`OPENROUTER_API_KEY`) unlocks ~hundreds of models — zero per-model adapter work.
- Matches the user's stated intent: *"OpenRouter will be used as a tool when orchestrating tasks."*

## Non-goals

- Not an agent adapter. The agent does not run on OpenRouter; it *calls* OpenRouter.
- No streaming surface in v1 — single completion request, blocking.
- No autonomous routing logic. The agent picks the model; the tool does not infer.

## House-style placement

Matches `packages/plugins/plugin-llm-wiki/` layout but **much smaller** (tool-only, no UI, no DB namespace, no agent, no managed project):

```
packages/plugins/plugin-openrouter-consult/
├── package.json
├── tsconfig.json
├── valadrien-os-plugin.json    # manifest
├── README.md
└── src/
    ├── index.ts                # entrypoint
    ├── tools/
    │   └── consult-model.ts    # the single tool
    └── shared/
        ├── config.ts           # zod schema for plugin config
        └── models.ts           # curated allowlist + helpers
```

## Manifest shape (target)

`valadrien-os-plugin.json`:
- `name`: `@valadrien-os/plugin-openrouter-consult`
- `kind`: `tool-pack`
- `tools`:
  - `consult_model`
    - input: `{ model: string, prompt: string, system?: string, maxTokens?: number, temperature?: number }`
    - output: `{ model: string, text: string, finishReason: string, usage: { promptTokens, completionTokens, totalTokens } }`
- `secrets`:
  - `openrouter_api_key` — companyScope, required
- `permissions`:
  - egress to `openrouter.ai`

Confirm exact manifest schema against `packages/plugins/plugin-llm-wiki/valadrien-os-plugin.json` at implementation time.

## Implementation checklist (deferred — do not start tonight)

### 1. Package scaffold
- [ ] `mkdir -p packages/plugins/plugin-openrouter-consult/src/{tools,shared}`
- [ ] Copy `package.json` + `tsconfig.json` from `packages/plugins/plugin-workspace-diff/` (smallest existing tool-pack — confirm at impl time).
- [ ] `pnpm install` from repo root.

### 2. `consult_model` tool
In `src/tools/consult-model.ts`:
- Read `openrouter_api_key` via the plugin secret-ref API (`doc/plans/2026-04-26-plugin-secret-ref-company-scope.md`).
- POST `https://openrouter.ai/api/v1/chat/completions` with:
  - `Authorization: Bearer <key>`
  - `HTTP-Referer: https://valadrien.dev` (recommended by OpenRouter)
  - `X-Title: ValAdrien OS`
- Default `temperature: 0.2`, `max_tokens: 2000`.
- Surface OpenRouter errors verbatim — they include the cost/quota explanation the calling agent needs.
- Track and return usage so the agent's run ledger can charge against the OpenRouter budget.

### 3. Model allowlist
In `src/shared/models.ts`:
- Start with a curated list to prevent agents picking deprecated / expensive models:
  - `anthropic/claude-3.5-sonnet`
  - `openai/gpt-4o-mini`
  - `openai/gpt-4o`
  - `meta-llama/llama-3.1-405b-instruct`
  - `meta-llama/llama-3.3-70b-instruct`
  - `deepseek/deepseek-chat`
  - `deepseek/deepseek-r1`
  - `mistralai/mistral-large`
  - `google/gemini-2.5-pro`
- Tool input validates against this allowlist. Plugin config exposes `allowAnyModel: boolean` (default `false`) for power users.
- Update list at impl time from https://openrouter.ai/models.

### 4. Cost guard
- Plugin config gets `maxCostPerCallUsd: number` (default `0.50`).
- Tool reads OpenRouter pricing from the response or the generation endpoint and rejects calls whose estimated cost exceeds the cap.
- Future: tie into the company budget service (see `doc/plans/2026-03-14-budget-policies-and-enforcement.md`).

### 5. Tool discovery wiring
- Standard tool-pack plugins surface automatically through the plugin loader. Verify by:
  - installing locally via `pnpm valadrien-os plugin install packages/plugins/plugin-openrouter-consult`
  - confirming `consult_model` appears in the agent's tool list during a task
- No changes needed in `server/src/agents/tools/` core if the plugin contract is honored.

### 6. Tests
- vitest with mocked fetch for happy path, 402 quota, 429 rate limit, allowlist rejection.
- Snapshot the request body so we catch accidental header drops (the `HTTP-Referer` + `X-Title` headers materially affect OpenRouter ranking).

## Why agents will reach for this

Concrete triggering moments:

1. **Cross-check** — Claude says X. Agent runs `consult_model({ model: "openai/gpt-4o", prompt: "Critique this answer: <X>" })` before committing.
2. **Cheap drafting** — Use `gpt-4o-mini` for a first pass, then escalate to the primary agent's runtime.
3. **Long-context offload** — Route a 400k-token doc into `gemini-2.5-pro` even when the agent itself runs on Claude.
4. **Reasoning specialization** — `deepseek-r1` for math-heavy turns without leaving the main agent runtime.

This is exactly the "tool for orchestration" framing from the user.

## Open questions

1. **Streaming.** v1 blocks. v2 may stream chunks back to the calling agent through the tool surface — but ValAdrien OS tool calls today are request/response, not streaming. Out of scope unless the platform adds streaming tool returns.
2. **Cost-aware routing.** Should we ship a `consult_cheapest_capable` companion tool that picks the model? Probably not — keep the plugin dumb, let the agent decide. Revisit after seeing usage patterns.
3. **Per-company vs per-agent budgets.** Tie into the company budget service when it lands. For now, `maxCostPerCallUsd` is a static per-plugin guardrail.

## Sequencing

1. Perplexity adapter plan (done).
2. This plan (done).
3. Scaffold + tool + tests (next session).
4. Wire into the company plugin registry of `valadrien-dev` (the meta-company) so we dogfood it first.

## Out of scope

- DeepSeek native adapter — covered cheaply by `consult_model({ model: "deepseek/..." })`. Reconsider a native adapter only if we want DeepSeek as a primary agent runtime, not a side-call.
- OpenRouter as a primary agent runtime — explicit user direction: it's a tool, not an adapter.
