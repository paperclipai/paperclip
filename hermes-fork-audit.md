# Hermes Fork Audit: inline `hermes_local` vs upstream `@paperclipai/hermes-paperclip-adapter`

- **Change**: `sync-upstream-internalize-hermes`
- **Date**: 2026-06-27
- **Verifier**: sdd-apply (deepseek-v4-pro), Sub-run 1A
- **Scope**: fork's inline `hermes_local` code in `server/src/adapters/registry.ts` lines 557–725, `server/src/adapters/hermes-wrapper.ts`, `server/src/adapters/hermes-test.ts`, `server/src/adapters/hermes-runtime-config.ts`, `server/src/services/hermes-config-sync.ts`, `server/src/routes/hermes-config-events.ts`, plus UI files `ui/src/adapters/hermes-local/`, `ui/src/components/HermesIcon.tsx` vs upstream `@paperclipai/hermes-paperclip-adapter` v0.3.1 (`packages/adapters/hermes/`)
- **Upstream stable tag**: `v2026.626.0` (commit `4c6c0c6ad`)
- **Hermes image tag**: `nousresearch/hermes-agent:v2026.6.19`

## Method

Audit performed as read-only comparison between fork working tree and upstream tagged source at `v2026.626.0`. For each of the 13 features in design §2, the fork's inline implementation was compared against upstream `packages/adapters/hermes/src/` (server, ui, cli, shared modules) and `packages/adapters/hermes-gateway/`. Fork files inventoried via `git ls-files | grep -i hermes`; upstream structure via `git ls-tree v2026.626.0 packages/adapters/`. Upstream package `@paperclipai/hermes-paperclip-adapter` v0.3.1 exports both `createServerAdapter()` (type `hermes_local`) and `createHermesGatewayServerAdapter()` (type `hermes_gateway`) plus all standalone modules needed for registration.

## Findings

| # | Feature | Fork source (file:lines) | Upstream equivalent (file:symbol) | Disposition | Severity | Notes |
|---|---------|--------------------------|-----------------------------------|-------------|----------|-------|
| 1 | `hermes_local` / `hermes_gateway` registration | `registry.ts:557-725` (inline `hermesLocalAdapter`), `builtin-adapter-types.ts:16` (`hermes_local`), `ui/src/adapters/hermes-local/index.ts` | `src/index.ts:createServerAdapter()` returns full `ServerAdapterModule` for `hermes_local`; `src/gateway/index.ts:createServerAdapter()` for `hermes_gateway` | port-upstream | block | Upstream factories cover both types. Fork's UI adapter (`ui/src/adapters/hermes-local/index.ts`) delegates to `hermes-paperclip-adapter/ui` already. Registration must be wired via upstream factory calls in registry rewrite (Task 1.3). |
| 2 | Command resolution (`hermesCommand`, `command`, default `hermes` on `PATH`) | `registry.ts:251-253` (`normalizeHermesConfig` migrates legacy `command` → `hermesCommand`), `hermes-wrapper.ts:24` (imports upstream `execute`) | `src/server/execute.ts:resolveHermesCommand()` → `hermesCommand` / `command` / `HERMES_CLI` (`"hermes"`); `src/shared/constants.ts:HERMES_CLI` | port-upstream | block | Upstream's `resolveHermesCommand` covers the same precedence. Fork's `normalizeHermesConfig` is a thin migration helper for legacy configs — not needed after merge (existing agents already use `hermesCommand`). |
| 3 | Local-agent JWT/API key injection and `PAPERCLIP_*` runtime env | `registry.ts:576-634` (builds env with `PAPERCLIP_API_KEY` from authToken, `PAPERCLIP_AGENT_ID`, `PAPERCLIP_COMPANY_ID`, `PAPERCLIP_API_URL`, `PAPERCLIP_RUN_ID`, `PAPERCLIP_TASK_ID`, `PAPERCLIP_TASK_TITLE`, `PAPERCLIP_TASK_BODY`, `PAPERCLIP_WAKE_REASON`, `PAPERCLIP_WAKE_COMMENT_ID`, `PAPERCLIP_WAKE_PAYLOAD_JSON`, `PAPERCLIP_LINKED_ISSUE_IDS`, `HERMES_HOME`) | `src/server/execute.ts:~430-465` (uses `buildPaperclipEnv` + injects `PAPERCLIP_API_KEY` from authToken, `PAPERCLIP_RUN_ID`, `PAPERCLIP_TASK_ID`, `PAPERCLIP_WAKE_REASON`, `PAPERCLIP_WAKE_COMMENT_ID`, `PAPERCLIP_WAKE_PAYLOAD_JSON`) | port-upstream | block | Core auth/task env vars covered by upstream. Fork injects 4 extra vars (`TASK_TITLE`, `TASK_BODY`, `LINKED_ISSUE_IDS`, `HERMES_HOME`) — these are enhancements not required for boot/execution. |
| 4 | `HERMES_HOME` / shared config/session/memory behavior | `registry.ts:569-574` (resolves `sharedHermesHome` from config → process.env → `/paperclip/hermes`), `hermes-wrapper.ts:54-62` (`resolveSharedHermesHome` with `os.homedir()` fallback) | `src/server/skills.ts:27-36` (`resolveHermesHome` for skills scanning; no explicit `HERMES_HOME` env injection) | follow-up-issue | enhancement | Upstream lets Hermes use its own default (`~/.hermes`). Fork overrides `HERMES_HOME` via env var. Container runtime (`/paperclip/hermes`) is handled by Docker ENV in PR #2; adapter should not hardcode it. |
| 5 | Model/provider detection from Hermes config | `registry.ts:580-584` (calls `detectModelFromHermesWrapper`), `hermes-wrapper.ts:307-319` (uses `parseHermesModelFromConfig` from upstream, reads `config.yaml`) | `src/server/detect-model.ts:detectModel()` — reads `~/.hermes/config.yaml`, extracts model/provider/base_url/api_key/api_mode; `parseModelFromConfig()` + `resolveProvider()` + `inferProviderFromModel()` | port-upstream | block | Upstream's model detection is more comprehensive (handles `base_url`, `api_mode`, multiple provider inference strategies). Fork's wrapper delegates to upstream's `parseHermesModelFromConfig` — equivalent core, upstream is richer. |
| 6 | Wake prompt, task markdown, session handoff, Paperclip API guidance | `registry.ts:271-336` (`buildHermesNativePaperclipPrompt` — 35+ line native API contract), `registry.ts:660-677` (task context, wake prompt), `registry.ts:591-602` (wake payload rendering) | `src/server/execute.ts:82-225` (`HERMES_DEFAULT_PROMPT_TEMPLATE` + `buildPrompt()` with `renderPaperclipWakePrompt`, `DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE`, session handoff markdown, conditional sections) | follow-up-issue | enhancement | Upstream's prompt covers the essentials (API guidance, curl patterns, multiline update pattern). Fork's prompt is more detailed with exhaustive native API contract. Both work; fork's richer prompt could be upstreamed as a follow-up. |
| 7 | Session codec/resume and unknown/missing session behavior | `registry.ts:707` (uses `hermesSessionCodec` from upstream), `hermes-wrapper.ts:22-23` (imports `hermesSessionCodec`) | `src/server/index.ts:sessionCodec` — `deserialize`/`serialize`/`getDisplayId` for `sessionId` field; `src/server/execute.ts:447-449` (passes `--resume` with `persistSession && prevSessionId`) | port-upstream | block | Fork delegates sessionCodec to upstream already. Upstream's execute handles `--resume` flag. Session continuity is fully covered. |
| 8 | Skills support: list/sync Paperclip skills, user Hermes skills, preload behavior | `hermes-wrapper.ts:68-103` (`prepareHermesPaperclipSkills` — symlinks Paperclip skills into `HERMES_HOME/skills/paperclip/`, reports preloaded/missing), `hermes-wrapper.ts:114-320` (scans user Hermes skills, builds snapshot), `registry.ts:260-268` (`withHermesPaperclipSkillArgs` — adds `--skills` CLI arg) | `src/server/skills.ts:listHermesSkills`/`syncHermesSkills` — scans Hermes skills as read-only metadata, merges with Paperclip skills. `syncHermesSkills` is a no-op (Hermes manages its own skills). No symlink management, no `--skills` CLI injection. | keep-fork | enhancement | Upstream treats skills as metadata only. Fork actively symlinks Paperclip skills and passes `--skills` to Hermes CLI for preloading. Hermes runnable without preloading (falls back to prompt instructions). The active symlink+preload model is a genuine fork enhancement. |
| 9 | Config schema, UI parser, CLI formatter, transcript behavior | `ui/src/adapters/hermes-local/index.ts` (delegates `parseStdoutLine`/`buildConfig` to upstream), `ui/src/adapters/hermes-local/config-fields.tsx` (custom `instructionsFilePath` field) | `src/server/config-schema.ts:getConfigSchema()` — 12-field schema; `src/ui/parse-stdout.ts`; `src/ui/build-config.ts`; `src/cli/format-event.ts` | port-upstream | block | Fork's UI adapter delegates to upstream for parser and config builder. Fork's custom `config-fields.tsx` adds `instructionsFilePath` which upstream handles via `supportsInstructionsBundle: true` + `instructionsPathKey`. Upstream's `getConfigSchema()` provides full config form schema. |
| 10 | Environment test diagnostics and secret redaction expectations | `hermes-test.ts:1-157` (8 checks: CLI probe, MCP binary, Python dep, API URL, shared home, shared config, provider credentials, paperclip skill sources/links) | `src/server/test.ts` (7 live checks: `hermes --version`, `python3 --version`, model config, API keys in config.env/process.env/`~/.hermes/.env`, provider/model consistency, Hermes config model detection) | port-upstream | enhancement | Both cover similar ground. Upstream's test is live-execution (actually runs `hermes --version`, `python3 --version`, reads `~/.hermes/.env`). Fork's test is static-path reporting. Upstream is more rigorous; fork's extra checks (skill symlinks, MCP paths) are enhancement-only. |
| 11 | Benign stderr handling and process spawn/cancel metadata | `hermes-wrapper.ts:228-256` (`executeHermesWrapper` — wraps upstream execute with skill prep, delegates process spawn) | `src/server/execute.ts:471-491` (`wrappedOnLog` reclassifies benign stderr patterns as stdout — structured timestamps, INFO/DEBUG/WARN levels, MCP init noise, tool registrations) | port-upstream | block | Upstream's `wrappedOnLog` handles stderr reclassification directly. Fork delegates execution to upstream (via `hermesExecute`), so it inherits this behavior. No fork gap. |
| 12 | Fork-only config push/drift sync (`/api/hermes/events`, `hermes-config-sync`, runtime config cache) | `hermes-config-sync.ts:1-66` (HMAC verification, event dedup, version tracking), `hermes-config-events.ts:1-69` (POST `/api/hermes/events` webhook), `hermes-runtime-config.ts:1-70` (runtime config cache with 10s TTL), `registry.ts:679-693` (log + cache on execute), `app.ts:38,175` (route mount), `routes/agents.ts:827-878,1454` (Hermes identity mapping), `heartbeat.ts:330,2395,6766-6829` (drift reconciliation) | No upstream equivalent. Upstream has no Hermes config push webhooks, runtime config cache, identity mapping, or drift reconciliation. | drop-without-replacement | enhancement | Fork-only infrastructure for syncing Hermes config changes to Paperclip. Not required for Hermes to boot, execute, or resume sessions. The runtime config cache (`hermes-runtime-config.ts`) is also fork-only and only powers the log line on execute. |
| 13 | Docker runtime assumptions: binary path, Python venv, uv/uvx, Playwright path | `registry.ts:574` (default `hermesHome` = `/paperclip/hermes`), `hermes-test.ts:34` (default `hermesHome` = `/paperclip/hermes`) | No upstream equivalent. Upstream uses `os.homedir()` → `~/.hermes`; adapter is container-agnostic. | follow-up-issue | enhancement | Container paths belong in Dockerfile ENV (PR #2), not hardcoded in adapter. The adapter should remain path-agnostic; the Docker image provides the correct `HERMES_HOME` and `PATH` at build time. Fork's `/paperclip/hermes` default will be superseded by Dockerfile `ENV HERMES_HOME=/paperclip/hermes`. _PR #1 begins row 13 closure: the `fix-docker-deploy-and-verify-hermes/pr-1` adapter change introduces `packages/adapters/hermes/src/server/hermes-home.ts` (HERMES_HOME > HOME > USERPROFILE > os.homedir() resolver) and migrates `skills.ts`, `detect-model.ts`, and `test.ts` to use it. Rows 4 and 13 are marked `resolved` in PR #3 of the same change, with row 13 attributed to two sources: the prior upstream sync that already removed fork adapter-side `/paperclip/hermes` hardcoding by restoring upstream `HOME + .hermes` behavior, and the `hermes-home.ts` resolver that adds operator-level `HERMES_HOME` override support._ |

### Disposition legend

| Disposition | Meaning |
|-------------|---------|
| `keep-fork` | Fork code must be preserved — upstream does not cover this feature |
| `port-upstream` | Fork code is superseded by upstream equivalent — port to upstream factory |
| `drop-without-replacement` | Fork code has no upstream equivalent and is not needed for built-in Hermes to function |
| `follow-up-issue` | Fork code has value but is not critical for built-in Hermes to boot/run — create a follow-up issue |

### Severity legend

| Severity | Meaning |
|----------|---------|
| `block` | Built-in Hermes cannot boot, execute, protect secrets, or resume sessions without this |
| `enhancement` | Improves the operator or agent experience but is not required for core function |

## Critical-port list

Rows where `severity = block`. These MUST be ported before PR #1 deletes fork Hermes code.

| Row # | Feature | Reason |
|-------|---------|--------|
| 1 | `hermes_local` / `hermes_gateway` registration | Server won't boot/list Hermes without adapter registration. Upstream factories (`createServerAdapter()` / `createHermesGatewayServerAdapter()`) must be wired in registry rewrite (Task 1.3). |
| 2 | Command resolution | Adapter must resolve `hermes` binary to spawn. Upstream `resolveHermesCommand()` covers this; fork's `normalizeHermesConfig` migration wrapper is not needed post-merge. |
| 3 | API key injection and `PAPERCLIP_*` runtime env | Hermes agent cannot authenticate to Paperclip API without `PAPERCLIP_API_KEY`. Upstream injects core auth/task env vars; 4 extra fork vars (TASK_TITLE, TASK_BODY, LINKED_ISSUE_IDS, HERMES_HOME) are not critical. |
| 5 | Model/provider detection from Hermes config | Agent execution needs correct model/provider. Upstream `detectModel()` covers this with richer provider inference; fork's wrapper delegates to upstream's `parseHermesModelFromConfig`. |
| 7 | Session codec/resume | Session continuity across heartbeats is a core invariant. Upstream `sessionCodec` + `--resume` flag covers this; fork already delegates to upstream's codec. |
| 9 | Config schema, UI parser, CLI formatter | Agent creation form needs config schema; run viewer needs transcript parser. Upstream provides all three modules (`config-schema.ts`, `parse-stdout.ts`, `format-event.ts`). |
| 11 | Benign stderr handling | Run transcripts must not render Hermes MCP init noise as errors. Upstream `wrappedOnLog` reclassifies benign stderr patterns; fork delegates execution to upstream and inherits this.

## Follow-up list

Rows where `disposition = follow-up-issue`. These become issues after PR #1 lands.

| Row # | Feature | Suggested issue title |
|-------|---------|-----------------------|
| 4 | `HERMES_HOME` / shared config behavior | "Hermes: container HERMES_HOME via Docker ENV, remove adapter hardcoding" |
| 6 | Wake prompt / Paperclip API guidance | "Evaluate porting fork's richer Hermes native prompt to upstream" |
| 13 | Docker runtime assumptions | "Remove `/paperclip/hermes` hardcoding from adapter; rely on Docker ENV" |

## Deletion checklist

Files to delete after audit confirms `covered` or `drop` disposition for all features:

- [ ] `server/src/adapters/hermes-wrapper.ts` — wrappers around upstream execute/sessionCodec/skills/detectModel; superseded by direct upstream factory calls
- [ ] `server/src/adapters/hermes-test.ts` — fork environment test; upstream `src/server/test.ts` covers diagnostics
- [ ] `server/src/adapters/hermes-runtime-config.ts` — fork runtime config cache (Row 12: drop-without-replacement)
- [ ] `server/src/services/hermes-config-sync.ts` — fork config push sync (Row 12: drop-without-replacement)
- [ ] `server/src/routes/hermes-config-events.ts` — fork webhook endpoint (Row 12: drop-without-replacement)
- [ ] `ui/src/adapters/hermes-local/config-fields.tsx` — fork UI instructionsFilePath field; upstream handles via `supportsInstructionsBundle`
- [ ] `ui/src/adapters/hermes-local/index.ts` — fork UI adapter wrapper; upstream provides full UI module

Call sites to prune (imports, mounts, invocations):

- [ ] `server/src/app.ts` — remove `import { hermesConfigEventRoutes }` (line 38) and `app.use("/api", hermesConfigEventRoutes(db))` (line 175)
- [ ] `server/src/index.ts` — remove startup/periodic Hermes drift reconciliation calls (lines 719, 791)
- [ ] `server/src/services/agents.ts` — remove `import { invalidateHermesRuntimeConfig }` (line 23) and Hermes-specific adapter type checks (lines 381, 444)
- [ ] `server/src/routes/agents.ts` — remove fork-only Hermes identity mapping (lines 827–878) and `GET /companies/:companyId/adapters/hermes/mappings` (lines 1454–1477); remove `hermes_local` instructionsFilePath mapping (line 131)
- [ ] `server/src/services/heartbeat.ts` — remove `hermes_local` from sessioned adapter allow-list (line 330), Hermes drift constants/state/functions (lines 2395, 6766–6829), Hermes drift telemetry (lines 6828–6829)
- [ ] `server/src/adapters/registry.ts` — replace inline `hermesLocalAdapter` (lines 557–725) with upstream `createHermesLocalServerAdapter()`; delete fork helper functions `normalizeHermesContextTask` (196–225), `normalizeHermesConfig` (229–258), `withHermesPaperclipSkillArgs` (260–268), `buildHermesNativePaperclipPrompt` (271–336); remove fork Hermes imports (lines 133–146, 152); add upstream imports from `@paperclipai/hermes-paperclip-adapter`
- [ ] `ui/src/adapters/registry.ts` — verify Hermes UI adapter registered via upstream module (may need to switch from fork wrapper to upstream)
- [ ] `server/src/adapters/builtin-adapter-types.ts` — already includes `hermes_local`; verify `hermes_gateway` is also present (or add it)

Preserve:
- `ui/src/components/HermesIcon.tsx` — generic Hermes branding icon, not fork-specific
- `doc/HERMES_DASHBOARD_DEPLOYMENT.md` — removed in PR #1 (fork-only Spanish doc; upstream has no equivalent; removal confirmed by Sub-run 1B)

## Conclusion

**Verdict**: `audit-failed` — 7 rows with `severity = block` (rows 1, 2, 3, 5, 7, 9, 11). All 7 are `port-upstream`, meaning upstream `@paperclipai/hermes-paperclip-adapter` v0.3.1 already covers every blocking feature. No row has `severity = block` AND `disposition = keep-fork` — there is no critical functionality gap where upstream lacks a needed feature.

The 7 block rows will be resolved by Task 1.3 (registry rewrite) which wires upstream's `createHermesLocalServerAdapter()` and `createHermesGatewayServerAdapter()` factories in place of the fork's inline `hermesLocalAdapter` object. Task 1.4 then deletes the orphaned fork shims.

**Disposition summary**:

| Disposition | Count | Rows |
|-------------|-------|------|
| `port-upstream` | 8 | 1, 2, 3, 5, 7, 9, 10, 11 |
| `keep-fork` | 1 | 8 (skills preloading — enhancement only) |
| `follow-up-issue` | 3 | 4, 6, 13 |
| `drop-without-replacement` | 1 | 12 |

**Readiness for Sub-run 1B**: Proceed. All blocks have upstream equivalents; registry rewrite (Task 1.3) resolves them. The one `keep-fork` row (skills preloading) is enhancement — not required for boot, auth, execution, or session continuity. The three follow-up rows are non-blocking enhancements tracked as separate issues.
