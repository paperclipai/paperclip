# 008 — First-Class Local LLM Adapter (Ollama / LM Studio / llama.cpp)

## Suggestion

Paperclip ships many local *coding-tool* adapters (claude_local, codex_local, gemini_local,
grok_local, opencode_local, pi_local, hermes_local) plus generic `http` and `process`
adapters — but there is **no first-class adapter for a local LLM server** like Ollama, LM
Studio, or llama.cpp. These are the obvious way to run agents with **zero marginal token
cost** and **full data privacy**, which is a compelling story for an "always-on, 24/7"
autonomous company where API spend is the main constraint. Today an operator could wire one
up via the raw `process`/`http` adapter, but it's bespoke, undiscoverable, and its cost
tracking is wrong.

The good news: the plumbing is already half there. `inferOpenAiCompatibleBiller`
(`packages/adapter-utils/src/billing.ts`) already infers a provider from `OPENAI_BASE_URL` /
`OPENAI_API_BASE`, and `pi-local` already runs through the OpenAI-compatible path. Ollama
(`:11434/v1`), LM Studio (`:1234/v1`), and llama.cpp's server all expose **OpenAI-compatible
`/v1` endpoints** — so a dedicated adapter is mostly configuration, presets, and correct
cost accounting on top of machinery that exists.

## How it could be achieved

1. **New builtin adapter `local_llm`** (or `openai_compatible_local`) added to
   `BUILTIN_ADAPTER_TYPES` in `server/src/adapters/builtin-adapter-types.ts`, modeled on the
   existing `pi-local` package under `packages/adapters/`.
2. **Config = base URL + model + optional key.** Fields: `baseUrl` (default presets for the
   three runtimes), `model` (free-text, since local model names are arbitrary), optional
   `apiKey` (LM Studio/llama.cpp ignore it; some setups want it). Ship one-click presets:
   **Ollama**, **LM Studio**, **llama.cpp**.
3. **Reuse OpenAI-compatible execution + billing.** Point the existing OpenAI-compatible
   client at the configured base URL. Extend `inferOpenAiCompatibleBiller` to detect
   loopback/LAN hosts (`localhost`, `127.0.0.1`, `*.local`, private ranges, `:11434`,
   `:1234`) and map them to a **`local` provider with $0 cost** — while still recording token
   counts so productivity metrics and the Diminishing-Returns Detector (idea 003) keep
   working even when spend is zero.
4. **Health probe + model discovery.** Reuse `environment-probe.ts` to check the endpoint is
   up before launch, and call the runtime's model-list endpoint (Ollama `/api/tags`, OpenAI
   `/v1/models`) to populate a model dropdown instead of free-text where possible.
5. **Docs + preflight.** A short "Run agents on your own GPU" doc, and a check in the
   Dry-Run Estimator (idea 004) that confirms the local endpoint is reachable and the named
   model is pulled before "hit go."

## Why it matters strategically

A local-LLM path makes Paperclip's "always-on 24/7" pitch economically realistic for hobbyist
and privacy-sensitive operators, and it pairs naturally with mixed fleets — cheap local models
for high-volume low-stakes agents (triage, summarization, routine reviews) and premium API
models for the CEO/critical-path roles. That mixed-economy story is a differentiator, not just
a connector.

## Perceived complexity

**Low–Medium.** Most of the runtime and billing infrastructure already exists and has a direct
in-repo template (`pi-local` + `inferOpenAiCompatibleBiller`). The bulk of the work is a new
adapter package, the loopback/LAN → `$0 local provider` billing rule (so cost tracking stays
honest), preset/health/model-discovery UX, and docs. The main correctness risk is the billing
inference: misclassifying a local endpoint as a paid provider (or vice-versa) corrupts cost
data, so that rule needs solid test coverage — `billing.test.ts` already exists to extend.
