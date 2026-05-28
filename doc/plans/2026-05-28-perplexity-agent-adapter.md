# Perplexity Agent Adapter — Plan

**Status:** Proposed — scaffolded as plan only on 2026-05-28. No code yet.
**Owner:** ValAdrien.DEV
**Scope:** Add `perplexity_agent` as a first-class adapter so agents in ValAdrien OS can run on Perplexity's Agent / Sonar APIs alongside `claude_local`, `codex_local`, etc.

## Why

- Perplexity's Sonar / Agent API gives us a research-grade adapter with built-in citations, freshness, and tool use without us having to assemble a Claude + web-search rig ourselves.
- Sits naturally next to `claude_local`, `codex_local`, `grok_local` — the user already has API access.
- Distinct from "OpenRouter as a tool" (see `2026-05-28-plugin-openrouter-consult.md`): Perplexity here is the **agent runtime** (it owns the turn-by-turn loop), not a model fallback.

## Non-goals

- No Perplexity Browser ("Comet") integration tonight — that's a separate desktop automation surface.
- No multi-model routing inside the adapter; one Perplexity model per agent for v1.
- No streaming-citation UI work in this plan — citations land as message metadata only.

## House-style placement

Matches `packages/adapters/grok-local/` layout exactly:

```
packages/adapters/perplexity-agent/
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts              # barrel
    ├── shared/               # config schema, model list, types
    ├── server/               # execute(), HTTP client
    ├── cli/                  # optional: bench / smoke commands
    └── ui/                   # settings card if needed
```

## Implementation checklist (deferred — do not start tonight)

### 1. Package scaffold
- [ ] `mkdir -p packages/adapters/perplexity-agent/src/{shared,server,cli,ui}`
- [ ] Copy `package.json` + `tsconfig.json` from `packages/adapters/grok-local/` and rename:
  - `name`: `@valadrien-os/adapter-perplexity-agent`
  - keep workspace deps identical to grok-local until proven otherwise
- [ ] `pnpm install` from repo root once scaffold exists

### 2. Register as builtin
- [ ] Add `"perplexity_agent"` to `AGENT_ADAPTER_TYPES` in `packages/shared/src/constants.ts`
- [ ] Add `"perplexity_agent"` to `BUILTIN_ADAPTER_TYPES` in `server/src/adapters/builtin-adapter-types.ts`
- [ ] Wire into `server/src/adapters/registry.ts` (mirror how `grok_local` is registered — find via `rg "grok_local" server/src/adapters/registry.ts`)
- [ ] Add UI label if `packages/shared/src/constants.ts` carries an `AGENT_ADAPTER_LABELS` map (check at implementation time)

### 3. Config schema (zod)
In `src/shared/config.ts`:
- `apiKey` — `secretRef` (use the existing plugin secret-ref pattern, see `doc/plans/2026-04-26-plugin-secret-ref-company-scope.md`)
- `model` — enum of current Sonar models, default `"sonar-pro"`
- `searchMode` — `"web" | "academic" | "none"`, default `"web"`
- `maxTokens` — number, default 4000
- `temperature` — number, default 0.2
- `returnCitations` — boolean, default `true`

### 4. Server `execute()`
In `src/server/execute.ts`:
- Implement the standard adapter `execute({ messages, tools, signal, onEvent })` contract — look at `packages/adapters/grok-local/src/server/execute.ts` for the canonical shape.
- POST to `https://api.perplexity.ai/chat/completions` (Sonar) **or** the Agent API endpoint when we move to multi-step.
- v1: single-turn completion. v2: agent loop with `search_results` events.
- Map Perplexity `citations[]` → ValAdrien OS message metadata so the UI's citation pill renders without changes.
- Propagate `signal` for cancellation; surface 429/402/quota errors as recoverable.

### 5. Model list
In `src/shared/models.ts`:
- `sonar`, `sonar-pro`, `sonar-reasoning`, `sonar-reasoning-pro`, `sonar-deep-research`
- Mark `sonar-deep-research` as long-running so the runner doesn't tag it as a hang.
- Pull canonical list from https://docs.perplexity.ai/guides/model-cards at implementation time — model list churns.

### 6. Secret handling
- Keep the API key in the company-scoped secret store (same pattern as Anthropic key for `claude_local`).
- Adapter must refuse to start if no key resolves — error message must mention the exact `secretRef` name.

### 7. Smoke tests
- One vitest fixture under `src/server/__tests__/execute.test.ts` that mocks the HTTP layer (don't burn API quota in CI).
- Snapshot the citation-to-metadata mapping.

### 8. Onboarding wizard exposure
- After landing, surface `Perplexity Agent` as a selectable adapter in the agent-creation flow in `ui/src/components/OnboardingWizard.tsx` (where `claude_local` / `codex_local` are listed). Add label + "best for research" blurb.

## Open questions

1. **Agent API vs Chat Completions API.** Sonar chat completions ship today; the dedicated Agent API (multi-step, tool-use, persistent threads) is newer and gated. v1 ships chat completions; v1.1 upgrades to Agent API if the API key has access.
2. **Citation surface.** Do we want citations as message metadata only, or as inline link decorations in the chat UI? Plan says metadata first; UI follow-up is out of scope.
3. **Reasoning models.** `sonar-reasoning-pro` returns chain-of-thought separately from the answer. Decide at impl time: hide CoT, store it on the run record, or render under a disclosure.

## Sequencing

1. This plan doc (done).
2. OpenRouter tool plan doc (next, same night).
3. Scaffold + register adapter (next session, after laptop has resources back).
4. `execute()` + smoke tests.
5. Wizard exposure.

## Out of scope

- Perplexity Browser ("Comet") computer-use adapter — different surface, separate plan.
- DeepSeek API adapter — flagged earlier but parked; will need its own plan doc if revived.
