# @paperclipai/adapter-opencode-local

## Unreleased

### Patch Changes

- Add an explicit stdin wake-focus hint for `issue_assigned` runs with `PAPERCLIP_TASK_ID`, forcing the model to act on the triggered issue before triaging unrelated assignments; includes a regression test in `execute.test.ts`.
- Expand stale-workspace-file detection/retry to cover OpenCode "must read file ... before overwriting it" guard messages (in addition to "modified since it was last read"), so these concurrency/read-order failures retry once and classify as `opencode_stale_workspace_file` when persistent.
- Treat non-zero `opencode run` exits as heartbeat success when JSONL ends with `step_finish` reason `stop`, no parsed error is present, and stderr is empty; preserve the real `exitCode` for diagnostics while setting `resultJson.paperclip.ignoredNonZeroExitCode` (`reason: opencode_last_step_finish_stop`) so server heartbeat outcome logic aligns with successful streamed work.
- Retry OpenCode execution once with a fresh run when tool-call validation fails (for example `webfetch` invalid-args errors), including no-session runs, so transient/stale schema mismatches do not immediately hard-fail the heartbeat.
- When tool-call validation errors indicate invalid `webfetch.format` values, retry runs now append an explicit repair hint to stdin (`format` must be `text|markdown|html`, never `json`) to reduce repeated schema failures on the next attempt.
- When OpenCode returns path-resolution failures (`File not found`, `ENOENT`/`no such file`), the adapter retries once with a path-recovery hint (verify files from current repo root, prefer repository-relative paths, avoid stale absolute paths from other workspaces).
- Retry once on permission auto-reject even when no session resume is active; keep existing session-resume retry behavior and clear saved session linkage when needed.
- Expand non-interactive permission bootstrap to include `webfetch` and `network` (`allow`) in both `OPENCODE_PERMISSION` merge and injected runtime `opencode.json`, reducing headless permission denials for tool calls.
- Fix `execute` control flow so session-retry branches (unknown session, permission auto-reject, stale workspace file) stay inside the async `try` block; this resolves LaunchAgent startup/runtime transpile failures caused by stray `await` usage outside an async function.
- `execute` now treats non-timeout OpenCode model-discovery failures (`opencode models` unexpected errors) as runtime warnings and continues with the configured model; explicit `Configured OpenCode model is unavailable` remains a hard error.
- Treat heartbeat workspace `source` **`adapter_config`** like **`agent_home`** when applying optional adapter `cwd` override.
- `execute`: treat API-key-related stderr/parsed errors case-sensitively on the already-lowercased blob (drop redundant `/i` on the API key regex); log a **warning** when `OPENCODE_PERMISSION` JSON cannot be parsed or normalized, then continue with `external_directory: "allow"`.
- Environment test (`testEnvironment`) refactors OpenCode model discovery into a shared helper, aligns discovery failure levels with whether a model ID is configured, and clarifies `opencode_hello_probe_model_unavailable` messaging when no model is set.
- OpenCode **environment hello probe** wall clock increased from **60s** to **120s** to reduce false timeouts on slower hosts during agent bootstrap validation.
- When `timeoutSec` is 0 or omitted in adapter config, heartbeats now use the shared **3600s** default child-process cap (via `@paperclipai/adapter-utils`) instead of running without a wall-clock limit.
- Emit stable `errorCode` values on failure (`timeout`, `opencode_permission_auto_reject`, `opencode_auth_required`, `opencode_stale_workspace_file`, `opencode_exit_nonzero`) for heartbeat aggregation and operator triage.
- When OpenCode fails because a file was **modified on disk after it was read** (common for `memory/YYYY-MM-DD.md` under concurrent runs or external edits), `execute` **retries once** with a fresh `opencode run` (no `--session` when a session was resumed) so the model re-reads the file; if the retry still fails, failures surface as `opencode_stale_workspace_file` instead of a generic `opencode_exit_nonzero`.
- Expand `$AGENT_HOME` in the composed stdin prompt to the real agent workspace path before `opencode run`, matching managed instruction prose and preventing `File not found: …/$AGENT_HOME/HEARTBEAT.md` when the model copies paths literally against the worktree cwd.
- `discoverOpenCodeModels` spawns `opencode models` with a closed stdin pipe instead of `ignore`, avoiding OpenCode CLI failures (`stdin is not a terminal`) when the API process has no TTY.
- `execute` now treats `opencode models` discovery timeouts as a runtime warning, continuing with the configured model instead of failing the heartbeat before OpenCode starts.
- `execute` now injects an `OPENCODE_PERMISSION` allowlist for managed agent instruction bundles that live outside the workspace, so symlinked `AGENTS.md`/`HEARTBEAT.md` files do not fail with `external_directory`.
- `execute` sets `OPENCODE_PERMISSION` `external_directory` to **`"allow"`** (OpenCode v2 global `PermissionActionConfig`). Per-path maps did not match prompts in non-interactive `opencode run`, which then **auto-rejected** with messages like `permission requested: external_directory (...); auto-rejecting`.
- When a resumed session still fails with permission auto-reject / “user rejected permission”, `execute` **retries once** without `--session` so the next heartbeat can start from a fresh OpenCode session while clearing stored session linkage on failure (same pattern as unknown-session recovery).

## 0.3.1

### Patch Changes

- Stable release preparation for 0.3.1
- Updated dependencies
  - @paperclipai/adapter-utils@0.3.1

## 0.3.0

### Minor Changes

- Stable release preparation for 0.3.0

### Patch Changes

- Updated dependencies
  - @paperclipai/adapter-utils@0.3.0

## 0.2.7

### Patch Changes

- Add local OpenCode adapter package with server/UI/CLI modules.
