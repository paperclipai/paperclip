---
phase: 4
title: Server registry + agent config doc
status: completed
priority: P1
effort: 4h
dependencies:
  - 2
  - 3
---

# Phase 4: Server registry + agent config doc

## Overview

Wire the `qwen-local` adapter into the central server adapter registry so paperclip discovers it at startup. Verify the adapter shows up in `/api/adapters` and that an agent created with `type: "qwen_local"` dispatches via the new execute path.

## Requirements

- `server/src/adapters/registry.ts` imports the new adapter and registers it alongside claude/codex/opencode/etc.
- Adapter discoverable through whatever route returns the adapter catalog to the UI.
- New agents persisted with `type = "qwen_local"` survive a server restart and dispatch correctly.

## Architecture

`registry.ts` is a flat module that imports each adapter's `execute`, `testEnvironment`, `sessionCodec`, model lists, and `agentConfigurationDoc`, then composes a single `ServerAdapterModule` map keyed by adapter `type`. Add `qwen_local` to that map. No new abstraction.

## Related Code Files

- Modify: `server/src/adapters/registry.ts`
- Read: same file (to see how opencode-local entries are structured), plus `server/src/adapters/types.ts` for the `ServerAdapterModule` shape.

## Implementation Steps

1. Add imports at the top of `server/src/adapters/registry.ts` mirroring the opencode block:
   ```ts
   import {
     execute as qwenExecute,
     testEnvironment as qwenTestEnvironment,
     sessionCodec as qwenSessionCodec,
     getConfigSchema as getQwenConfigSchema,
     listQwenModels,
   } from "@paperclipai/adapter-qwen-local/server";
   import {
     agentConfigurationDoc as qwenAgentConfigurationDoc,
     models as qwenModels,
     modelProfiles as qwenModelProfiles,
   } from "@paperclipai/adapter-qwen-local";
   ```
2. Add the `qwen_local` entry to whichever map/array `registry.ts` exposes (mirror opencode's entry shape exactly).
3. Add the package as a workspace dep in `server/package.json`: `"@paperclipai/adapter-qwen-local": "workspace:*"`.
4. Run `pnpm install` then `pnpm -F @paperclipai/server build`.
5. Manual smoke: start the server, hit the adapters list endpoint (or open the UI), confirm `qwen_local` appears with its config doc and model list.

## Success Criteria

- [x] Server build green.
- [x] Adapter listed in adapters catalog response.
- [x] Creating a `qwen_local` agent via UI persists; restarting the server re-loads it.
- [x] No other adapters regressed (smoke each).

## Risk Assessment

- Risk: registry import order or naming collision. Mitigation: prefix every imported symbol with `qwen` to match the file's existing pattern.
- Risk: workspace dep not picked up. Mitigation: explicit `pnpm install` after editing `server/package.json`; verify `node_modules/@paperclipai/adapter-qwen-local` symlink.
