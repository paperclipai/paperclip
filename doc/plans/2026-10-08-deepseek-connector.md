# DeepSeek as a first-class AI provider

Date: 2026-10-08. Status: implemented and verified; working tree uncommitted.

## Finish line

DeepSeek is a native first-class AI provider beside OpenAI and Anthropic, with only an
API-key method (like Google). One connection installs on OpenCode, Hermes, Codex, or
Claude agents; the server derives the protocol and base URL from the harness. The change
adds the catalog card, model picker, runtime projection, recovery env keys, and an
on-demand usage probe. Verified end-to-end with a live DeepSeek key. Prepare a reviewed
PR; merging is a separate human action.

## Decisions

- Native provider, not advanced/OpenRouter routing. The connection is stored without a
  user-visible `routing`; `kind:"deepseek"` is synthesized server-side from the harness.
- All four harnesses in v1: `opencode_local`, `hermes_local`, `codex_local`,
  `claude_local`. DeepSeek reuses existing harnesses, so `aiProviderForAdapter` cannot
  name a provider from a harness alone; the connect dialog gains an explicit provider
  chooser instead of guessing.
- Carriers: generic `paperclip` provider for OpenCode and Codex (the native-runner
  allowlist exposes `PAPERCLIP_AI_PROVIDER_KEY`/`PAPERCLIP_AI_PROVIDER_URL`), the
  `paperclip` stanza with `wire_api="responses"` for Codex, `/anthropic` with
  `deepseek-flash[1m]` for Claude, and a custom endpoint for Hermes. No new runner
  allowlist keys.
- Only an API-key method; no subscription and no live catalog without the key. The
  picker uses a static list with a connection-scoped live refresh. Effort is normalized
  to `low|high|max` (DeepSeek also normalizes the wider domain itself).

## Changes

- Shared: `AI_PROVIDERS` and `AI_CONNECTION_CAPABILITIES.deepseek`;
  `aiProviderRoutingSchema.kind` plus invariants; `aiRoutingBaseUrl`;
  `deepseek-models.ts` (`DEEPSEEK_MODELS`, `deepseekReasoningEffort`,
  `protocolForDeepSeekHarness`); `supportsAiConnectionUsage`; `CONNECTABLE_APP_SLUGS`;
  `testCredentials`.
- Catalog and branding: `aiCatalogEntries` entry, generated `deepseek.json` and
  `app-definitions.generated.ts`; sanitized official `deepseek.svg` and manifest entry.
- Database: both provider CHECK constraints extended; migration `0321`; snapshot window.
- Server: DeepSeek branch in `managedProviderRouting` (effort, `[1m]`); native
  `projectionRouting` synthesis in `ai-connection-runtime`; `validateAiApiKey` endpoint;
  recovery env map; `agent-environment-test.ts` provider→adapter map; `deepseek()` balance probe;
  `listDeepSeekModels` plus `aiConnectionService.listModels` and
  `GET /companies/:companyId/ai-connections/:connectionId/models`; a no-guess fix in
  `ai-auth-failure`.
- UI: `AI_PROVIDERS`; native `AiProviderSetup` tile; api-key branch in
  `AiConnectionCredentialStep`; static+live model picker in `useConnectionModels`;
  provider chooser in `AiConnectionField`; `providerDisplayName` and env-key maps.
- Docs: `doc/connections/AI-CONNECTIONS.md` (compatibility table, Advanced note, usage,
  OpenClaw) and `doc/SPEC-implementation.md`.

## Verification

Targeted, in a Linux copy (WSL, Node 24 / pnpm 9, CRLF→LF normalized):

- Server `tsc --noEmit` and UI `tsc -b` pass.
- `ai-provider-routing` 15/15; `ai-connection-usage` 33/33; `deepseek-models` 2/2;
  `ai-connections` 107/107; `tool-access-service` 388/388; `ai-auth-failure` 23/23;
  shared `app-definitions` 33/33; UI `AiConnectionField`/`AiProviderSetup`/
  `useConnectionModels`/`app-connect-policy`/`model` 52/52.
- Full `pnpm test:run`: 16885 passed, 6 failed, 75 skipped across 817 files. Five
  failures are environment (missing `.git`; Linux symlink/`rmSync`) and reproduce on a
  clean checkout; one was a DeepSeek recovery regression, now fixed. Storybook builds.

Live smoke against `https://api.deepseek.com` (real key, not retained):

- `GET /models`: `deepseek-flash` (1M context, vision) and `deepseek-v4-pro`.
- `GET /user/balance`: prepaid balance mapped to overage; the live probe returned
  `status:"ok"`.
- Chat Completions, Anthropic Messages, and Responses all return 200; the full effort
  domain is accepted.
- Harness e2e returned `pong`, exit 0: OpenCode (`paperclip/deepseek-flash`), Hermes
  (custom endpoint), Codex (`paperclip`, responses), and Claude Code (`/anthropic`,
  `[1m]`).

## Current state

- [x] Shared identity, routing, effort, models, and usage-probe support.
- [x] Catalog entry, generated artifacts, and branding.
- [x] Database CHECKs and migration `0321`.
- [x] Server projection, recovery, live model list, and usage probe.
- [x] UI wiring, including the provider chooser.
- [x] Docs updated.
- [x] Live key verification across all four harnesses and three protocols.
- [x] Full test run and Storybook build.
- [ ] PR review and CI.

## Remaining (optional / conditional)

- `deepseek-dark.svg` (the mark is blue and stays legible on dark surfaces).
- `ai-connection-router` pool-member runtime config, only if DeepSeek accounts may join
  routing pools.
- OpenClaw steps are documented in `AI-CONNECTIONS.md`; the generated card help stays
  generic.
- CI regeneration of `app-definitions` with the full capture corpus (a local
  `--definitions-only` run drops corpus-derived fields).
