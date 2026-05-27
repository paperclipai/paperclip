# Hermes Paperclip Adapter 0.2.0 to 0.3.0 Diff - 2026-05-27

## Status

- Status: analysis draft.
- Risk level: L1 local planning document.
- Package changes applied: none.
- DB/config/agent changes applied: none.
- Commit/push/PR/merge executed: none.

This document covers step 2 of the Hermes-first redesign plan.

## Commands Run

```powershell
corepack pnpm list hermes-paperclip-adapter -r --depth 0
corepack pnpm view hermes-paperclip-adapter@0.3.0 dist.tarball version dependencies peerDependencies --json
Invoke-WebRequest <0.3.0 tarball> -OutFile $env:TEMP\yoon-hermes-adapter-diff\hermes-paperclip-adapter-0.3.0.tgz
tar -xzf $env:TEMP\yoon-hermes-adapter-diff\hermes-paperclip-adapter-0.3.0.tgz -C $env:TEMP\yoon-hermes-adapter-diff\v0.3.0
git diff --no-index <local 0.2.0 file> <temp 0.3.0 file>
```

## Current Installed Version

Installed in the Paperclip repo:

```text
@paperclipai/server -> hermes-paperclip-adapter 0.2.0
@paperclipai/ui     -> hermes-paperclip-adapter 0.2.0
```

Latest available npm package:

```text
hermes-paperclip-adapter 0.3.0
```

## Package-Level Result

Files unchanged:

- `README.md`
- `dist/server/skills.js`
- `dist/ui/parse-stdout.js`
- `dist/index.js`

Files changed:

- `package.json`
- `dist/server/execute.js`
- `dist/server/test.js`
- `dist/server/detect-model.js`
- `dist/shared/constants.js`
- `dist/ui/build-config.js`

## Important Behavior Changes

### 1. Provider resolution changed

Version `0.2.0` used an explicit `provider` when provided and only passed it if it was in `VALID_PROVIDERS`.

Version `0.3.0` adds `resolveProvider()`:

1. explicit `adapterConfig.provider`
2. detected provider from `~/.hermes/config.yaml`, only when the detected model matches
3. model-name prefix inference
4. `auto`

It also adds model prefix hints:

- `gpt-5` -> `copilot`
- `gpt-4`, `o1`, `o3`, `o4` -> `openai-codex`
- `claude` -> `anthropic`
- `glm` -> `zai`
- `kimi` -> `kimi-coding`
- `minimax` -> `minimax`

Risk for YoonCompany:

- Our Hermes Paperclip agent currently uses `model=gpt-5.5` and `provider=openai-codex`.
- Because the provider is explicit, 0.3.0 should keep `openai-codex`.
- If the explicit provider is removed later, 0.3.0 may infer `gpt-5.5 -> copilot`, which may not be what the PM expects.

Recommendation:

- Keep explicit provider during upgrade.
- Add a regression test that `provider=openai-codex` wins for `gpt-5.5`.

### 2. Default timeout changed

Version `0.2.0`:

```text
DEFAULT_TIMEOUT_SEC = 300
```

Version `0.3.0`:

```text
DEFAULT_TIMEOUT_SEC = 1800
```

Risk:

- Longer runs are useful for real Hermes orchestration.
- But a stuck Paperclip heartbeat can now hold a process for 30 minutes by default.

Recommendation:

- Keep explicit `timeoutSec` on YoonCompany agents.
- For orchestrator profiles, choose timeout by role instead of accepting package default blindly.

### 3. `--max-turns` support changed

Version `0.3.0` maps `adapterConfig.maxTurnsPerRun` to Hermes CLI:

```text
--max-turns <n>
```

Risk:

- This is better than hiding max turns inside `extraArgs`.
- Our current Hermes agent uses `extraArgs=["--yolo","--max-turns","8"]`.

Recommendation:

- Move `--max-turns 8` out of `extraArgs` and into `maxTurnsPerRun` when upgrading.
- This is an agent config mutation and therefore L3.

### 4. `--yolo` is now always added by the adapter

Version `0.3.0` always pushes:

```text
--yolo
```

The adapter comment says Paperclip agents are non-interactive and would otherwise hang on approval prompts.

Risk:

- Our current agent already has `extraArgs=["--yolo", ...]`.
- Upgrading without cleanup likely duplicates `--yolo`.
- More importantly, the Hermes-first safety model should not rely on prompt-only rules if `--yolo` is active.

Recommendation:

- Treat adapter 0.3.0's built-in `--yolo` as a design fact.
- Move safety to Paperclip approvals, toolset restrictions, profile isolation, and workspace boundaries.
- Remove duplicate `--yolo` from `extraArgs` only after approved config migration.

### 5. Provider/API key diagnostics changed

Version `0.3.0` adds:

- Kimi API key check
- MiniMax API key check
- provider/model consistency warnings
- provider auto-detection info

Risk:

- Our local patch in `server/src/adapters/registry.ts` normalizes OpenAI Codex OAuth no-key warnings.
- The new provider checks may produce new warning codes that need normalization or test updates.

Recommendation:

- Upgrade in an isolated branch.
- Re-run `adapter-registry.test.ts` and add/adjust tests for OpenAI Codex OAuth and provider consistency.

## Hermes-First Relevance

Adapter 0.3.0 is useful but not sufficient.

It improves:

- provider/model handling
- max turn configuration
- longer default runtime
- diagnostics

It does not solve:

- Hermes profile isolation
- Hermes Kanban visibility in Paperclip
- Hermes `delegation`/`kanban` toolset exposure strategy
- Paperclip issue <-> Hermes task ID mapping
- Hermes dashboard embedding/deep-linking

Therefore the next work should not be "just upgrade the package." It should be:

1. add read-only Hermes status visibility
2. prepare explicit config migration
3. then upgrade package under tests

## Upgrade Plan Draft

1. Create branch for adapter upgrade only.
2. Change `server/package.json`, `ui/package.json`, and lockfile from `^0.2.0` to `^0.3.0`.
3. Remove duplicate `--yolo` from future Hermes orchestrator config only after approval; do not alter existing DB config during package upgrade.
4. Keep explicit `provider=openai-codex` for YoonCompany Hermes until a provider policy is approved.
5. Add tests for:
   - OpenAI Codex OAuth no-key diagnostic remains pass/info.
   - `provider=openai-codex` is preserved for `gpt-5.5`.
   - `maxTurnsPerRun` is preferred over raw `extraArgs` in new config templates.
6. Run:

```powershell
corepack pnpm install --frozen-lockfile --ignore-scripts
corepack pnpm --filter @paperclipai/server exec tsc --noEmit
corepack pnpm --filter @paperclipai/ui typecheck
corepack pnpm --filter @paperclipai/server exec vitest run src/__tests__/adapter-registry.test.ts
corepack pnpm --filter @paperclipai/server exec vitest run src/__tests__/adapter-routes.test.ts
```

## Applied Follow-Up

The package upgrade was applied after this diff review:

- `server/package.json`: `hermes-paperclip-adapter ^0.3.0`
- `ui/package.json`: `hermes-paperclip-adapter ^0.3.0`
- `pnpm-lock.yaml`: resolved `hermes-paperclip-adapter 0.3.0`

Verification performed after applying:

```powershell
corepack pnpm list hermes-paperclip-adapter -r --depth 0
corepack pnpm --filter @paperclipai/ui typecheck
corepack pnpm --filter @paperclipai/plugin-sdk ensure-build-deps
corepack pnpm --filter @paperclipai/server exec tsc --noEmit
corepack pnpm exec vitest run --project @paperclipai/ui ui/src/components/YoonCompanyAssistantPanel.test.tsx ui/src/components/YoonCompanyHermesStatusPanel.test.tsx
corepack pnpm --filter @paperclipai/server exec vitest run src/__tests__/adapter-routes.test.ts
corepack pnpm --filter @paperclipai/server exec vitest run src/__tests__/adapter-registry.test.ts
```

Note: `corepack pnpm --filter @paperclipai/server typecheck` currently fails in this environment because the package script itself calls bare `pnpm`. The equivalent `corepack pnpm --filter @paperclipai/plugin-sdk ensure-build-deps` plus `corepack pnpm --filter @paperclipai/server exec tsc --noEmit` passed.

## Decision

The dependency upgrade is complete as an L2 package slice. Do not combine it with live Hermes agent config mutation. The remaining Hermes behavior change is approval-gated: remove or justify explicit `--yolo`, choose provider/session/toolset policy, then enable orchestrator profiles.
