# Plan: Antigravity CLI Local Adapter for Paperclip

Date: 2026-06-07
Author: Antigravity
Branch: `feat/antigravity-adapter`

## 1. Problem & Goal

The goal is to enable Paperclip to orchestrate local agents using the **Antigravity CLI** (`agy` command), similar to how it orchestrates Claude Code (`claude`) and Gemini CLI (`gemini`).

## 2. Design Decisions

1. **Adapter Type**: `antigravity_local`.
2. **Command Executable**: `agy` (resolved from the environment PATH or custom config, defaulting to `agy`).
3. **Session Management**: Supports resuming sessions using the `--conversation <id>` flag of the `agy` CLI.
4. **Permissions Bypass**: Passes `--dangerously-skip-permissions` to bypass interactive permission dialogs during unattended Paperclip runs.
5. **Sandbox Mode**: Respects the `sandbox` config option by passing `--sandbox` to the `agy` executable when enabled.
6. **Prompt Delivery**: Delivers the rendered template via the `--prompt` argument.

## 3. Implementation Details

We created a self-contained package `@paperclipai/adapter-antigravity-local` in `packages/adapters/antigravity-local` containing:
- `package.json` & `tsconfig.json` conforming to Paperclip adapter exports.
- `src/index.ts` containing adapter metadata, models list (`auto`, `gemini-2.5-pro`, `gemini-2.5-flash`), and `agentConfigurationDoc` markdown.
- `src/server/execute.ts` implementing the core process execution logic.
- `src/server/parse.ts` parsing plain text and JSONL output, extracting UUIDs as conversation/session IDs.
- `src/server/skills.ts` managing symlinked local skills inside `~/.gemini/antigravity-cli/skills`.
- `src/server/test.ts` executing `agy help` for environment diagnostic checks.
- `src/ui/parse-stdout.ts` converting lines into UI Transcript entries.
- `src/ui/build-config.ts` mapping form inputs to `adapterConfig`.
- `src/ui/config-fields.tsx` rendering agent creation/editing form fields.
- `src/cli/format-event.ts` formatting logs for CLI runner watchmode.

And registered it under:
- `server/src/adapters/builtin-adapter-types.ts`
- `server/src/adapters/registry.ts`
- `ui/src/adapters/registry.ts`
- `cli/src/adapters/registry.ts`

## 4. Verification & Testing

- Added unit tests in `server/src/__tests__/antigravity-local-adapter.test.ts` verifying parser extraction, stale session detection, turn-limit classification, UI line parsing, and CLI formatting.
- Tests executed and verified green:
  ```bash
  npx vitest run antigravity-local-adapter.test.ts
  ```
- Workspace packages linked and typechecked successfully:
  ```bash
  pnpm run preflight:workspace-links
  pnpm typecheck
  pnpm build
  ```
