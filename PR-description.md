# feat(adapters): harden OpenCode/Orca-spawned model discovery

## Motivation (resilience hardening, not a reproduced-defect fix)

When the Paperclip server is started from inside an OpenCode or Orca terminal,
`process.env` leaks OpenCode/Orca session variables (`OPENCODE=1`,
`OPENCODE_PID`, `OPENCODE_CONFIG_DIR`, and `ORCA_*` hooks). Paperclip's
`runChildProcess` already strips **Claude** nesting guards (`CLAUDECODE`,
`CLAUDE_CODE_*`) so spawned `claude` processes don't refuse to start, but it
does **not** strip the equivalent OpenCode/Orca variables.

Context on the observed symptom:
- We observed `opencode models` **time out after 20s** (`adapter_failed` /
  `OpenCode returned no models`) on a host running Paperclip inside Orca, even
  though the same CLI completes in <2s in a shell.
- **Causal status:** an independent challenger reproduced the exact historical
  load profile (6 concurrent interactive opencode sessions, CPU 50–84%, shared
  `opencode.db` ~397 MB) and `opencode models` stayed <1s across all
  measurements. **The timeout is not a reproducible consequence of env-leak or
  DB contention** — it was a one-off environmental/transient stall. This PR is
  therefore framed as **resilience hardening**, not a reproduced-defect fix.
- Independent of causality, these are each defensible hardening changes:
  1. spawned child processes should not inherit the parent's OpenCode/Orca
     session env (mirrors the existing claude strip), and
  2. a transient slow/unavailable model-discovery should not hard-fail a run
     whose model is explicitly pinned.

## Changes

### 1. `packages/adapter-utils/src/server-utils.ts` — strip OpenCode/Orca nesting env

In `runChildProcess`, after the claude nesting-guard strip, also delete:

- `OPENCODE`, `OPENCODE_PID`, `OPENCODE_CONFIG_DIR`, `OPENCODE_CLIENT`,
  `OPENCODE_ACP_PROFILE`
- every `ORCA_*` variable

Note: `OPENCODE=1` / `OPENCODE_PID` are self-set by opencode itself when it runs
as an agent (verified in the opencode source), so inherited copies are not an
abnormal state — this change is hygiene to avoid confusing the child process
with the parent's identity, consistent with the claude strip.

### 2. `packages/adapters/opencode-local/src/server/models.ts` — configurable timeout

`MODELS_DISCOVERY_TIMEOUT_MS` is now overridable via
`PAPERCLIP_OPENCODE_MODELS_TIMEOUT_MS` (default raised 20s → 30s). Operators on
contended hosts can raise it without a code change.

### 3. `packages/adapters/opencode-local/src/server/models.ts` — pinned-model fallback

`ensureOpenCodeModelConfiguredAndAvailable` now falls back to a small
**known-good model allowlist** when discovery returns no models or the pinned
model is absent (e.g. gateway-routed). If the pinned `adapterConfig.model` is on
the allowlist, the run proceeds instead of hard-failing on a transient discovery
problem. Discovery remains the source of truth whenever it succeeds.

## Verification

- `opencode models` completes in **<1s** with and without the leaked env vars,
  under concurrency, and from agent workspaces (reproduced independently).
- A run pinned to `opencode-go/deepseek-v4-flash` resolves via the fallback
  list even when `opencode models` discovery fails or is slow.
- No claude/OpenAI behaviour changed; the claude strip is untouched.

## Testing

- `pnpm --filter @paperclipai/adapter-utils typecheck`
- `pnpm --filter @paperclipai/adapter-opencode-local typecheck`
- Existing adapter tests (`pnpm test` in each package).

## Notes for maintainers

- The `ORCA_*` prefix sweep is deliberately broad: Orca/agent-terminal
  orchestrators export many hook vars; deleting them only affects spawned agent
  subprocesses (Paperclip's own `PAPERCLIP_*` vars are preserved by
  `sanitizeInheritedPaperclipEnv`).
- The fallback list is intentionally small and conservative. Extend it only with
  models you are confident are always available where this adapter runs.
