# Implement skill sync in `openrouter-local` adapter

**Branch:** `feat/openrouter-local-adapter` (active development branch — do not create a new branch)

## Background

Paperclip has a company skills system. Skills are directories containing a `SKILL.md` file (plus optional scripts). They are assigned to agents via `POST /api/agents/{agentId}/skills/sync`. At run time the server injects the assigned skills into the adapter's execution config as `config.paperclipRuntimeSkills` — an array of `PaperclipSkillEntry` objects with shape `{ key: string, runtimeName: string, source: string }` where `source` is the absolute path to the skill directory.

The `adapter-utils` package already has all required infrastructure:

- `readPaperclipRuntimeSkillEntries(config, moduleDir)` in `packages/adapter-utils/src/server-utils.ts` — reads `config.paperclipRuntimeSkills`, or falls back to discovering bundled skills from `../../skills` relative to `moduleDir`
- `buildPersistentSkillSnapshot(options)` — builds the `AdapterSkillSnapshot` for `listSkills`/`syncSkills`

The `openrouter-local` adapter already sets `requiresMaterializedRuntimeSkills = false` in `index.ts`, meaning skills are passed via config rather than written to disk. However, the adapter currently **ignores** `config.paperclipRuntimeSkills` entirely — skill content is never loaded into the system prompt, and the `skills/sync` API endpoint returns `{ supported: false, mode: "unsupported" }`.

Other adapters (`acpx-local`, `cursor-local`) have already implemented skill sync. Use them as reference implementations.

## Files to read before writing any code

```
packages/adapters/openrouter-local/src/server/execute.ts
packages/adapters/openrouter-local/src/server/instructions.ts
packages/adapters/openrouter-local/src/index.ts
packages/adapter-utils/src/server-utils.ts        # readPaperclipRuntimeSkillEntries, buildPersistentSkillSnapshot, PaperclipSkillEntry
packages/adapter-utils/src/types.ts               # AdapterSkillSnapshot, AdapterSkillEntry, AdapterSkillContext
packages/adapters/acpx-local/src/server/execute.ts
packages/adapters/acpx-local/src/index.ts         # reference: listSkills / syncSkills pattern
packages/adapters/openrouter-local/src/server/execute.test.ts
```

## What needs to change

### 1. `packages/adapters/openrouter-local/src/server/instructions.ts`

Add a new exported function `loadSkillFragments` that accepts an array of `PaperclipSkillEntry` and returns `InstructionFragment[]` by reading `SKILL.md` from each entry's `source` path. Skip entries where `SKILL.md` is missing or empty. Follow the same `InstructionFragment` shape used by the existing `loadInstructionFragments`.

### 2. `packages/adapters/openrouter-local/src/server/execute.ts`

After calling `loadInstructionFragments`, call `readPaperclipRuntimeSkillEntries(config, import.meta.dirname)` and `loadSkillFragments(skillEntries)`. Prepend skill fragments before the AGENTS.md/HEARTBEAT.md fragments (match the ordering convention used by other adapters). Add a `system` transcript log entry stating how many skill fragments were loaded, consistent with the existing `"loaded N instruction fragment(s)"` log style.

### 3. `packages/adapters/openrouter-local/src/index.ts`

Add `listSkills` and `syncSkills` exports so the server can power the `skills/sync` API endpoint. After this change the endpoint must return a proper `AdapterSkillSnapshot` with `supported: true`. Follow the exact pattern from `acpx-local/src/index.ts`.

### 4. Tests

- **`packages/adapters/openrouter-local/src/server/instructions.test.ts`** — unit tests for `loadSkillFragments`:
  - happy path: valid SKILL.md content appears in returned fragments
  - missing SKILL.md: entry is silently skipped
  - empty SKILL.md: entry is silently skipped

- **`packages/adapters/openrouter-local/src/server/execute.test.ts`** — integration test verifying that when `config.paperclipRuntimeSkills` names a skill directory containing a real SKILL.md, that content appears in the system prompt sent to the model.

### 5. Documentation

- Update `agentConfigurationDoc` in `index.ts` to mention that assigned company skills are automatically included in the system prompt via `paperclipRuntimeSkills`.
- Add or update `docs/adapters/openrouter-local.md` (create if it does not exist) to note that skill sync is now supported.
- If a monorepo adapter feature matrix or changelog exists, add an entry there.

## Runtime skill source paths

When this feature is live, skill `source` paths injected into `config.paperclipRuntimeSkills` will point at directories under the crew repo bind mount (see `docs/specs/crew-repo-integration.md`). For the LinkCast deployment these will look like:

```
/paperclip/companies/linkcast/skills/agent-delegate/
```

The `loadSkillFragments` implementation reads `SKILL.md` and any supplementary `.md` files from `{source}/`. Shell scripts at `{source}/scripts/` are also accessible at that absolute path — agents can invoke them directly using the full path rather than a relative `skills/...` reference. The SKILL.md for crew-repo skills should reference scripts as `${SKILL_DIR}/scripts/agent-poll-issue.sh` or document that the full bind-mounted path should be used.

## Deployment note

After the changes are committed to `feat/openrouter-local-adapter`, the Docker container must be rebuilt manually — the user will handle this step.

`gh` CLI is 1Password-shimmed and will fail when called from non-interactive shells. Do not rely on `gh` in scripts or tool calls; leave any GitHub CLI steps as manual instructions.

## Walkthrough and Build Results

### Implementation Steps

1. **Adapter Skill API implementation (`listSkills`, `syncSkills`)**
   - Created `packages/adapters/openrouter-local/src/server/skills.ts` to implement `listSkills` and `syncSkills` leveraging `@paperclipai/adapter-utils/server-utils` (specifically `buildPersistentSkillSnapshot`).
   - Exported these functions in `packages/adapters/openrouter-local/src/server/index.ts`.
   - Wired them up in the control plane's `server/src/adapters/registry.ts` to expose the skill capabilities to the rest of the application.

2. **Skill Fragments Loading (`loadSkillFragments`)**
   - Implemented `loadSkillFragments` in `packages/adapters/openrouter-local/src/server/instructions.ts`. This utility reads the `SKILL.md` content from each provided `PaperclipSkillEntry`'s `source` directory, skipping empty files or missing files.

3. **Execution Injection (`execute.ts`)**
   - Modified `packages/adapters/openrouter-local/src/server/execute.ts` to import and call `readPaperclipRuntimeSkillEntries` (using `import.meta.dirname`) and `loadSkillFragments`.
   - Injected the resulting `InstructionFragment` items into the `fragments` array ahead of the `AGENTS.md` and `HEARTBEAT.md` bundle defaults.
   - Added a `system` transcript log to emit `"loaded N skill fragment(s)"` alongside the existing `"loaded N instruction fragment(s)"` log.

4. **Documentation Updates**
   - Updated `agentConfigurationDoc` in `packages/adapters/openrouter-local/src/index.ts` to explicitly document the `paperclipRuntimeSkills` integration.
   - Created `docs/adapters/openrouter-local.md` as an overview of the adapter's capabilities including supported skills sync and built-in tools.

5. **Testing**
   - Added unit tests in `packages/adapters/openrouter-local/src/server/instructions.test.ts` for `loadSkillFragments` verifying valid, missing, and empty `SKILL.md` handling.
   - Added an integration test in `packages/adapters/openrouter-local/src/server/execute.test.ts` to confirm `config.paperclipRuntimeSkills` causes the correct skill content to be injected into the system prompt and logs the event.
   - Fixed a preexisting mock configuration context issue (`taskTitle` mapping from `paperclipWake`) in `execute.test.ts`.

### Build Results

- **Unit and Integration Tests**: Ran `vitest run` on `packages/adapters/openrouter-local/src/server` successfully: `41 passed (41)`.
- **TypeScript Compilation**: Executed `tsc --noEmit` across both `packages/adapters/openrouter-local` and `server/` with zero errors (exit code `0`).

The `openrouter-local` adapter is now fully equipped to sync and load Paperclip Company Skills seamlessly.

### Files Changed / Created

- `packages/adapters/openrouter-local/src/server/skills.ts` (Created)
- `packages/adapters/openrouter-local/src/server/index.ts` (Modified)
- `packages/adapters/openrouter-local/src/server/instructions.ts` (Modified)
- `packages/adapters/openrouter-local/src/server/execute.ts` (Modified)
- `packages/adapters/openrouter-local/src/index.ts` (Modified)
- `server/src/adapters/registry.ts` (Modified)
- `packages/adapters/openrouter-local/src/server/instructions.test.ts` (Modified)
- `packages/adapters/openrouter-local/src/server/execute.test.ts` (Modified)
- `docs/adapters/openrouter-local.md` (Created)
- `docs/plans/openrouter-local-skill-sync-plan.md` (Modified)
