# TODOS

## Completed

**Title:** Fix workspace-runtime provision tests failing with global paperclipai install

**Fix:** Added `beforeEach`/`afterEach` in the `realizeExecutionWorkspace` describe block in `server/src/__tests__/workspace-runtime.test.ts` that (1) prepends a fake `paperclipai` (exits 1) to PATH so `paperclipai_command_available()` returns false regardless of global installs, and (2) clears `PAPERCLIP_CONFIG` from the test env so the host system config doesn't leak into `resolvePaperclipConfigPath()` calls. All 56 tests in the suite pass.

---

**Title:** Fix worktree-config port assignment tests

Test failures in `server/src/__tests__/worktree-config.test.ts`:
- `avoids sibling worktree ports when repairing legacy configs`
- `rebalances duplicate ports for already isolated worktree configs`

**Root cause:** Tests were not clearing `PAPERCLIP_CONFIG` and `PAPERCLIP_INSTANCE_ID` from `process.env` before calling `maybeRepairLegacyWorktreeConfigAndEnvFiles()`. Since `PAPERCLIP_CONFIG` is set in the dev environment, `resolvePaperclipConfigPath()` returned the real system config path instead of the test's temp config. The sibling port scan then operated on the wrong home directory, finding no siblings.

**Fix:** Added `delete process.env.PAPERCLIP_HOME/INSTANCE_ID/CONFIG/CONTEXT` in both failing tests (same pattern as the first test in the suite). Fixed in `server/src/__tests__/worktree-config.test.ts`.

