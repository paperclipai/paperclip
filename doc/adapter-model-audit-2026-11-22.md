# Adapter model audit: November 22, 2026

This audit follows the [November 18, 2026 audit](adapter-model-audit-2026-11-18.md).
It adds Gemini 4 Neon where its neighbouring Gemini 4 models already appear,
records the Google Antigravity model catalog for the pinned ACP server 1.5.2,
and maps which Gemini models each Google sign-in route can reach. Catalog
entries identify models; accounts, plans and keys determine access. No agent
defaults or saved model selections are migrated.

## Model changes

| Adapter | Change |
| --- | --- |
| OpenCode | Add `google/gemini-4-neon` to the static fallback, ahead of Carbon, Argon and Hydrogen. |
| Google Antigravity (Paperclip Runner) | API-key connections now get a model list on every environment, generated from the pinned runtime: 14 Gemini 3 models, then the 14 Gemini 4 models marked as needing a paid Gemini API plan. Google sign-in still reads the account's own list on the Paperclip host. |
| Gemini CLI, Cursor | No change. Neither list carries a Gemini 4 model, so Neon is not added on its own. Gemini CLI support for Gemini 4 stays deferred as in the November 18 audit. |
| Claude Code, Codex, Grok Build, Kimi Code, Pi, Hermes | No change. |

## Google Antigravity model catalog (ACP server 1.5.2)

A model ID is `<family>-<level>`: the family is the base model and the level
is its thinking level. The server's levels are `minimal`, `low`, `medium`,
`high` and `extra_high`. A Google account's own list spells extra high as
`xhigh`, adds `max`, and keeps five legacy IDs that do not spell their level
(for example `gemini-3-flash-agent` is Gemini 3.5 Flash at high). One shared
module, `packages/shared/src/antigravity-models.ts`, parses and formats every
spelling; each ID formats back to itself.

| Family | Levels, in the server's order | API key | Notes |
| --- | --- | --- | --- |
| Gemini 3.8 Flash | high, medium, low | Listed (default `gemini-3.8-flash-high`) | |
| Gemini 3.7 Flash | high, medium, low | Listed | |
| Gemini 3.6 Flash | high, medium, low | Listed | |
| Gemini 3.5 Flash | high, medium, low | Listed | |
| Gemini 3.1 Pro | high, low | Listed | Sent as `gemini-3.1-pro-preview` |
| Gemini 4 Carbon | medium, high, low | Selectable, needs a paid plan | Agent Platform default is `gemini-4-carbon-medium` |
| Gemini 4 Neon | high, extra_high, medium, low | Selectable, needs a paid plan | |
| Gemini 4 Hydrogen | high, extra_high, medium, low | Selectable, needs a paid plan | |
| Gemini 4 Argon | high, medium, low | Selectable, needs a paid plan | Vertex serves it only at location `global` |

No family offers `minimal` in 1.5.2. The earlier 25-model API-key lineup (five
families times five levels) was wrong; the real list has 14 models.

`node packages/paperclip-runner/scripts/generate-antigravity-models.mjs`
writes `packages/shared/src/antigravity-models.generated.ts` on darwin-arm64.
It starts the pinned, patched runtime with a placeholder API key (the server
does not check the key and builds this list locally), opens one session
without a prompt, and reads its model list. It also reads the families and
levels from the server's own catalog table in the verified vendor archive and
stops if the two disagree. The file records the runtime version and the
darwin-arm64 vendor archive and closure digests. Its `--check` mode
runs in the runner's TypeScript build and fails when the checked-in runtime
declaration changes or the file was edited by hand.

## Routes to each model

| Route | Gemini 3 (Flash, 3.1 Pro) | Gemini 4 (Carbon, Neon, Hydrogen, Argon) | State |
| --- | --- | --- | --- |
| Personal Google sign-in | Whatever the account's list offers | Whatever the account's list offers | Local Paperclip host only. Not exercised with a Gemini 4 account. |
| Gemini API key | Listed by the server | Not listed; selected through Paperclip's exact-model admission | Local and cloud environments. Gemini 4 needs a key on a paid plan with Gemini 4 quota. |
| Agent Platform (Vertex) | Listed | Listed | Advertised by the server; Paperclip has no Agent Platform connection. |

How a Gemini 4 model runs with an API key: the server marks the Gemini 4
families `agent_platform_only`, so a session started on its default model
refuses a later `set_model` to Neon. Paperclip does not start that way.
Its exact-model admission asks for the requested model when the session is
created. The server then keeps the model as a "custom model", sends the base
model with the thinking level to the Gemini Developer API, and the owned
admission patch checks that both match the requested ID before it acknowledges
the session. This needs no change to the admission patch and no
`AGY_ACP_DEFAULT_MODEL`.

## Sources and verification

Research date: November 22, 2026.

- The pinned server's `model_selection.py` (ACP server 1.5.2, darwin-arm64
  archive `123a16d5…4845`) defines the families, their levels,
  `agent_platform_only`, the account level spellings (`xhigh`, `max`) and the
  legacy IDs.
- Live, prompt-free check on darwin-arm64: one `gemini-api-key` session listed
  exactly the 14 IDs above, with `gemini-3.8-flash-high` current. The generated
  file is that list.
- Live, prompt-free check of admission: for all 28 IDs (14 Gemini 3 and 14
  Gemini 4) a session created with Paperclip's admission request returned an
  admission receipt for the exact ID, and `session/set_model` to the same ID
  was accepted. As a control, `set_model` to `gemini-4-neon-high` on a default
  API-key session was refused with "not available for the current
  authentication method".
- The Gemini Developer API model list for the test key includes
  `models/gemini-4-neon`, `gemini-4-carbon`, `gemini-4-hydrogen` and
  `gemini-4-argon`, all with thinking. The key is free tier, so no prompt was
  sent; Neon inference on a paid key is not yet observed.
- OpenRouter's public model list (`/api/v1/models`) includes
  `google/gemini-4-neon` (and a `:batch` variant). The models.dev registry that
  OpenCode reads lists `gemini-4-neon` under `google`, `google-vertex` and
  `openrouter`.

## Open items

- Observe one accepted Neon prompt per level with a Gemini API key on a paid
  plan; until then the Gemini 4 API-key lineup is admitted but not inferred.
- When Google refuses a model at run time (quota of zero, unknown model, or an
  auth-method refusal), the run should show the plain-language message from
  `antigravityModelRefusalMessage` instead of the provider's text. The runner
  driver owns that classification.
- Agent Platform connections and remote Google sign-in remain open decisions
  in the [qualification plan](plans/2026-11-22-antigravity-qualification.md).
