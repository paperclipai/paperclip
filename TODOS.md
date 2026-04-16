# TODOS

## Server / Workspace Runtime

**Priority:** P0
**Title:** Fix workspace-runtime provision tests failing with global paperclipai install

Test failures in `server/src/__tests__/workspace-runtime.test.ts`:
- `writes an isolated repo-local Paperclip config and worktree branding when provisioning`
- `provisions worktree-local pnpm node_modules instead of reusing base-repo links` (×2)
- `provisions successfully when install is needed but there are no symlinked node_modules`
- `retries worktree-local pnpm install without a frozen lockfile when the lockfile is outdated`
- `fails instead of writing an unseeded fallback config when worktree init errors after CLI detection succeeds`

**Root cause:** Tests assume `paperclipai` is NOT globally installed. When it is (e.g. via `npx -y paperclipai`), `paperclipai_command_available()` in `provision-worktree.sh` returns `true` and the real CLI is invoked. Different tests expect different behaviors: some expect fallback, some expect hard failure. The conflict is irresolvable without PATH isolation in the tests. Fix: each test that calls provision-worktree.sh should control PATH to include only the intended fake/real CLI (similar to how `fails instead of writing unseeded fallback` uses a fake pnpm bin dir).

**Priority:** P0
**Title:** Fix worktree-config port assignment tests

Test failures in `server/src/__tests__/worktree-config.test.ts`:
- `avoids sibling worktree ports when repairing legacy configs`
- `rebalances duplicate ports for already isolated worktree configs`

**Root cause:** `maybeRepairLegacyWorktreeConfigAndEnvFiles` returns port 3100 instead of 3102 (expected to skip sibling's 3101). Port allocation likely not reading sibling configs correctly. Noticed on branch `feature/f6-deploy-self-hosted` — pre-existing failure.

## Completed

