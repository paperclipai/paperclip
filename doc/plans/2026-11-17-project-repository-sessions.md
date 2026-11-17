# Project Repository Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agent sessions on a multi-repository project know which repositories they have, read each repository's own instructions, and start from a current default branch in the shared checkouts, without moving those checkouts off their default branch.

**Architecture:** Two server-side changes in the workspace layer. This layer serves the Paperclip Runner and the legacy direct adapters alike.

1. A repository note is appended to the task prompt after workspace preparation. It lists every repository by a path relative to the run's working directory and tells the agent to read that repository's `AGENTS.md`/`CLAUDE.md`.
2. The shared managed checkouts are refreshed when a run is about to use them. The refresh fetches and fast-forwards only when the checkout is clean and on its default branch. In every other case it only reports.

**Tech Stack:** TypeScript, Node `child_process` git, Vitest, embedded Postgres heartbeat tests.

**Spec:** this document. The design was agreed in conversation on 2026-11-17; the decisions are recorded under "Decisions" below.

## Decisions

- **Windows is not a target.** Build for the Paperclip Runner on macOS/Linux.
- **Why the note goes in the prompt.** Under the Runner, ACPX Claude runs with `settingSources: ["user"]` in isolated mode (`patches/@agentclientprotocol__claude-agent-acp@0.73.0.patch:196-199`, enabled by `PAPERCLIP_ACPX_ISOLATED_CONTEXT=1` in `packages/paperclip-runner/src/drivers/acpx/acpx-runtime-adapter.ts:436-452`). It therefore never loads a repository's `CLAUDE.md` or `.claude/skills`. A file written into the workspace would also be ignored. The prompt is the one channel that every runner and every adapter delivers, so the note goes there.
- **No polling worker.** `rules/sleep-aware-background-work.mdc` forbids a new idle polling worker. "Regularly pulled" is therefore implemented as: fetch when a run prepares a shared checkout and the last fetch is older than `SHARED_CHECKOUT_REFRESH_MIN_INTERVAL_MS`.
- **No automatic branch restore in this plan.** A concurrent run on the same shared checkout may be on another branch on purpose, and restoring would break it. This plan detects the situation and reports it. A holder-aware restore is follow-up work.
- **A user-configured local folder is never touched.** Only Paperclip-managed checkouts are refreshed: those from `ensureManagedProjectWorkspace`.

## Global Constraints

- `rules/heartbeat-execution-boundaries.mdc`: new behavior belongs in modules under `server/src/services/heartbeat/` or in a service file. `heartbeat.ts` gets wiring only, a few lines.
- `rules/sleep-aware-background-work.mdc`: no `setInterval`, no scheduler entry, no background scan.
- `rules/runtime-dependency-boundaries.mdc`: no new dependencies. Use `child_process` git the way neighboring files do.
- Paths in the prompt are relative to the run's working directory. Host absolute paths are wrong for remote and sandbox targets.
- A refresh failure never fails a run. It becomes a run warning.
- Machine load: run one test file at a time.

## Review Focus

1. **A concurrent run on the same shared checkout while another run fast-forwards it.** Expected: the fast-forward happens only when `git status --porcelain --untracked-files=no` is empty, so uncommitted work is never touched. Test: `does not fast-forward a checkout with tracked modifications` (Task 2).
2. **Two runs preparing the same checkout at the same moment.** Expected: one fetch; the second run awaits the first. Test: `coalesces concurrent refreshes of one checkout` (Task 2).
3. **A local branch that diverged from origin.** Expected: no reset, no merge commit; a notice says the branch has diverged. Test: `reports a diverged default branch without changing it` (Task 2).
4. **The network or credentials are unavailable.** Expected: the run continues on the current checkout, with a warning. Test: `continues with a notice when fetch fails` (Task 2).
5. **A hint path outside the working directory**, such as a referenced project elsewhere on disk. Expected: it is left out of the note rather than shown as `../..`. Test: `omits workspaces outside the working directory` (Task 1).

---

### Task 1: Repository note in the task prompt

**Files:**
- Modify: `server/src/services/heartbeat/task-context.ts` (add `appendTaskMarkdownNote`)
- Modify: `server/src/services/heartbeat/environment-selection.ts:472-500` (use `appendTaskMarkdownNote` instead of its local closure; behavior unchanged)
- Modify: `server/src/services/heartbeat/workspaces.ts` (add `buildRepositoryWorkspaceNote` next to `buildRunWorkspaceHints`, at line 1442)
- Modify: `server/src/services/heartbeat.ts:3369` (wiring, about 3 lines)
- Test: `server/src/services/heartbeat/workspaces.test.ts`, `server/src/services/heartbeat/environment-selection.test.ts` (existing concurrent-note cases must stay green)

**Interfaces:**
- Produces: `appendTaskMarkdownNote(context: Record<string, unknown>, note: string): void`. It appends `\n` + note to each of `paperclipTaskMarkdown`, `paperclipTaskMarkdownAssignment`, `paperclipTaskMarkdownCompact` and `paperclipTaskMarkdownAssignmentCompact`. The two compact fields are touched only when they are strings, which matches today's closure.
- Produces: `buildRepositoryWorkspaceNote(input: { cwd: string; anchorRepoUrl: string | null; anchorRepoRef: string | null; hints: Array<Record<string, unknown>>; sharedCheckout: boolean }): string | null`.

- [ ] **Step 1: Write the failing tests** in `workspaces.test.ts`, in a `describe("buildRepositoryWorkspaceNote")` block:

```ts
it("lists the anchor and nested repositories by relative path", () => {
  const note = buildRepositoryWorkspaceNote({
    cwd: "/w/proj/app",
    anchorRepoUrl: "https://github.com/acme/app.git", anchorRepoRef: null,
    hints: [{ workspaceId: "w2", cwd: "/w/proj/app/.paperclip-repositories/lib-1a2b", repoUrl: "https://github.com/acme/lib.git", repoRef: "main" }],
    sharedCheckout: true,
  })!;
  expect(note).toContain("- `.` — app (https://github.com/acme/app.git)");
  expect(note).toContain("- `.paperclip-repositories/lib-1a2b` — lib (https://github.com/acme/lib.git), ref main");
  expect(note).toContain("read its AGENTS.md or CLAUDE.md");
  expect(note).toContain("Do not switch the checked-out branch");
});
it("omits the branch rule for an isolated workspace", () => { /* sharedCheckout: false → not.toContain("Do not switch") */ });
it("omits workspaces outside the working directory", () => { /* hint cwd "/elsewhere/x" → note has no "elsewhere" and no ".." */ });
it("does not repeat the anchor when a hint points at the working directory", () => { /* hint cwd === cwd → "`.`" appears once */ });
it("returns null without any repository", () => { /* anchorRepoUrl null, hints [] → null */ });
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm vitest run server/src/services/heartbeat/workspaces.test.ts -t buildRepositoryWorkspaceNote`
Expected: FAIL, `buildRepositoryWorkspaceNote is not a function`.

- [ ] **Step 3: Implement `buildRepositoryWorkspaceNote` in `workspaces.ts`.** The repository name comes from `deriveRepoNameFromRepoUrl`, which already exists in this file. A relative path comes from `path.relative(cwd, hint.cwd)`: an empty result is the anchor; a result that starts with `..` or is absolute is skipped. The output is this exact text:

```
Repositories in this workspace (paths relative to your working directory):
- `<rel>` — <name> (<repoUrl>)[, ref <repoRef>]
Before you change files in a repository, read its AGENTS.md or CLAUDE.md if it has one; they are not loaded for you.
[shared only] Do not switch the checked-out branch of these shared checkouts. Use `git worktree add` when you need another branch.
```

- [ ] **Step 4: Run the tests and confirm they pass** (same command). Expected: PASS.

- [ ] **Step 5: Move the append logic.** Add `appendTaskMarkdownNote` to `task-context.ts` and replace the closure in `environment-selection.ts:477-500` with `appendTaskMarkdownNote(context, concurrentWorkspaceNote)`.
Run: `pnpm vitest run server/src/services/heartbeat/environment-selection.test.ts`
Expected: PASS, unchanged.

- [ ] **Step 6: Wire it in `heartbeat.ts` at line 3369.** Keep the hints in a local, `const workspaceHints = buildRunWorkspaceHints(resolvedWorkspace); context.paperclipWorkspaces = workspaceHints;`, and then:

```ts
const repositoryNote = buildRepositoryWorkspaceNote({ cwd: executionWorkspace.cwd, anchorRepoUrl: executionWorkspace.repoUrl,
  anchorRepoRef: executionWorkspace.repoRef, hints: workspaceHints, sharedCheckout: effectiveExecutionWorkspaceMode === "shared_workspace" });
if (repositoryNote) appendTaskMarkdownNote(context, repositoryNote);
```

- [ ] **Step 7: Add a heartbeat-level assertion** to `server/src/__tests__/heartbeat-project-repositories.test.ts`: a project with two repositories, a run is drained, and the captured adapter context's `paperclipTaskMarkdown` contains "Repositories in this workspace" and the `.paperclip-repositories/` entry. Use the file's existing setup and `drainHeartbeatRunsToQuiescence`.
Run: `pnpm vitest run server/src/__tests__/heartbeat-project-repositories.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add server/src/services/heartbeat/task-context.ts server/src/services/heartbeat/environment-selection.ts server/src/services/heartbeat/workspaces.ts server/src/services/heartbeat/workspaces.test.ts server/src/services/heartbeat.ts server/src/__tests__/heartbeat-project-repositories.test.ts
git commit -m "feat(workspaces): tell the agent which repositories a run has and to read their instructions"
```

### Task 2: Shared checkout refresh service

**Files:**
- Create: `server/src/services/shared-checkout-refresh.ts`
- Test: `server/src/__tests__/shared-checkout-refresh.test.ts`

**Interfaces:**
- Consumes: `refreshRemoteTrackingBaseRef(repoRoot: string, baseRef: string, resolveGitAuth?: GitRemoteAuthProvider | null): Promise<string[]>` from `server/src/services/workspace-runtime.ts:1028`. It fetches `origin/<branch>` with auth and returns warnings.
- Produces:

```ts
export const SHARED_CHECKOUT_REFRESH_MIN_INTERVAL_MS = 5 * 60_000;
export type SharedCheckoutRefreshStatus =
  | "fast_forwarded" | "up_to_date" | "skipped_recent" | "skipped_off_default_branch"
  | "skipped_dirty" | "skipped_diverged" | "skipped_no_default_branch" | "fetch_failed";
export type SharedCheckoutRefreshResult = { status: SharedCheckoutRefreshStatus; defaultBranch: string | null; currentBranch: string | null; notices: string[] };
export function refreshSharedManagedCheckout(cwd: string, options?: {
  resolveGitAuth?: GitRemoteAuthProvider | null; now?: () => number; minIntervalMs?: number;
}): Promise<SharedCheckoutRefreshResult>;
```

**Behavior**, in this order:

1. **Default branch:** `git symbolic-ref --short refs/remotes/origin/HEAD`, with the `origin/` prefix stripped. If there is none, return `skipped_no_default_branch` with no notice.
2. **Current branch:** `git symbolic-ref --short -q HEAD` (null when detached). If it differs from the default, return `skipped_off_default_branch` with the notice ``Shared checkout <basename> is on `<current>` instead of `<default>`; it was not updated.``
3. **Throttle:** read the marker at `git rev-parse --git-path paperclip-shared-checkout-refresh`, which holds epoch milliseconds. If `now - marker < minIntervalMs`, return `skipped_recent`.
4. **Fetch:** `refreshRemoteTrackingBaseRef(cwd, "origin/<default>", resolveGitAuth)`. Warnings, or a thrown error, give `fetch_failed` with a notice. Write the marker only after a successful fetch.
5. **Dirty check:** `git status --porcelain --untracked-files=no` is not empty → `skipped_dirty` with a notice.
6. **Merge:** `git merge --ff-only origin/<default>`. Exit code non-zero → `skipped_diverged` with a notice. HEAD unchanged → `up_to_date`. Otherwise → `fast_forwarded`.
7. **Coalescing:** keep a module-level `Map<string, Promise<SharedCheckoutRefreshResult>>` keyed by `path.resolve(cwd)`. A caller that arrives while a refresh is in flight awaits that same promise.

- [ ] **Step 1: Write the failing tests.** The fixture creates a bare `origin`, then a `git clone` of it, in an `mkdtemp` directory, the same way `server/src/__tests__/managed-repository-checkout.test.ts:12-22` does. A helper `advanceOrigin()` commits to origin through a second clone.
  - `fast-forwards a clean default-branch checkout that is behind`: after `advanceOrigin()`, the status is `fast_forwarded` and the clone's HEAD equals origin's.
  - `skips a second refresh inside the interval`: the second call, with the same `now`, returns `skipped_recent`.
  - `refreshes again after the interval`: a second call with `now + SHARED_CHECKOUT_REFRESH_MIN_INTERVAL_MS + 1` returns `fast_forwarded` after another `advanceOrigin()`.
  - `reports an off-default branch without changing it`: after `git switch -c feature`, the status is `skipped_off_default_branch`, the branch is still `feature`, and the notice contains `` `feature` `` and `` `main` ``.
  - `does not fast-forward a checkout with tracked modifications`: with an edited tracked file, the status is `skipped_dirty` and the file content is unchanged.
  - `ignores untracked files`: with an untracked file present, the status is `fast_forwarded`.
  - `reports a diverged default branch without changing it`: with a local commit plus `advanceOrigin()`, the status is `skipped_diverged` and the local HEAD is unchanged.
  - `continues with a notice when fetch fails`: after `git remote set-url origin /nonexistent`, the status is `fetch_failed`, the promise resolves without throwing, and the marker is not written.
  - `coalesces concurrent refreshes of one checkout`: two simultaneous calls return the same result object, and origin is fetched once (count it by wrapping `resolveGitAuth`, which is called once per fetch).

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm vitest run server/src/__tests__/shared-checkout-refresh.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `refreshSharedManagedCheckout`** with the behavior list above. Use a private `git(cwd, args)` built on `execFile` with a 30 s timeout (fetch is covered by `refreshRemoteTrackingBaseRef`), the same way `managed-repository-checkout.ts:43` does.

- [ ] **Step 4: Run the tests and confirm they pass** (same command). Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/shared-checkout-refresh.ts server/src/__tests__/shared-checkout-refresh.test.ts
git commit -m "feat(workspaces): fast-forward clean shared checkouts on their default branch"
```

### Task 3: Refresh managed checkouts when a run prepares them

**Files:**
- Modify: `server/src/services/heartbeat/workspaces.ts:448-499` (`ensureManagedProjectWorkspace`), plus the anchor path that consumes it (the call at line 598 and the place in `resolveAnchorWorkspaceForRun` where the managed `warning` is pushed into `warnings`)
- Test: `server/src/__tests__/heartbeat-project-repositories.test.ts`

**Interfaces:**
- Consumes: `refreshSharedManagedCheckout` (Task 2).
- Produces: the return type of `ensureManagedProjectWorkspace` becomes `{ cwd: string; warning: string | null; notices: string[] }`. `warning` keeps its current meaning, which callers treat as "materialization failed": see `workspaces.ts:555`. Refresh notices must never go into `warning`.

- [ ] **Step 1: Write the failing test** in `heartbeat-project-repositories.test.ts`: `refreshes the shared anchor checkout before a later run`.
  1. A project with a local bare-origin repository; the first run is drained.
  2. Origin is advanced, and `vi.setSystemTime` (or the injected `now`) moves past the interval.
  3. The second run is drained.
  - Assert that the managed checkout's HEAD equals the new origin commit.
  - Add a second case, `reports an off-default shared checkout as a run warning`: switch the managed checkout to a `feature` branch between the runs, and assert that the run's runtime workspace warnings contain "is on `feature`", while the branch is still `feature`.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm vitest run server/src/__tests__/heartbeat-project-repositories.test.ts -t "shared anchor checkout"`
Expected: FAIL, HEAD is still the old commit.

- [ ] **Step 3: Implement.** In `ensureManagedProjectWorkspace`, once the final origin check (line 488-497) has passed and `result.warning === null && input.repoUrl`, call `refreshSharedManagedCheckout(result.cwd, { resolveGitAuth: input.resolveGitAuth })` and return `{ ...result, notices: refresh.notices }`. Every other return path gets `notices: []`. In the anchor resolution, append `notices` to the same `warnings` array that receives the managed `warning`. Nested-repository callers (line 554) and `execution-workspaces.ts:4623` need no change beyond the type.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm vitest run server/src/__tests__/heartbeat-project-repositories.test.ts`
Then, one at a time: `pnpm vitest run server/src/__tests__/managed-repository-checkout.test.ts` and `pnpm vitest run server/src/services/heartbeat/workspaces.test.ts`
Expected: PASS for all of them.

- [ ] **Step 5: Run the selected verification**

Run: `pnpm verify`
Expected: exit 0. Exit 2 means broader coverage is needed: report it and leave that to CI (AGENTS.md §7).

- [ ] **Step 6: Commit**

```bash
git add server/src/services/heartbeat/workspaces.ts server/src/__tests__/heartbeat-project-repositories.test.ts
git commit -m "feat(workspaces): refresh managed shared checkouts when a run prepares them"
```

## Not in this plan (separate plans)

These need their own design decisions and would make this change too large to review.

1. **Starting the session in the project folder instead of the anchor checkout.**
   - Open decisions:
     - the cwd change breaks resumption of saved sessions, which are bound to their cwd;
     - runtime services are bound to the anchor workspace;
     - in isolated mode the layout becomes one task directory with a worktree per repository.
   - The plain task directory (`server/src/services/isolated-task-directory.ts`, `execution-workspace-repositories.ts:402`) is the existing precedent.
   - Native Codex already trusts a non-git cwd (`packages/paperclip-runner/runner/crates/runner-core/src/codex_startup_trust.rs:9-43`).
   - With Task 1 in place, the benefit is mostly a cleaner tree, so this has lower priority.
2. **Repository skills and instructions in the Runner's skill snapshot.** Because ACPX Claude ignores project sources, a repository's `.claude/skills` only reaches a Runner session if the server adds it to the runtime-context snapshot (`packages/paperclip-runner/README.md:460-465`). This is a company-scoping and trust decision: repository content would become session-loaded skills.
3. **Restoring a shared checkout to its default branch.** This needs knowledge of which run holds the workspace (`workspaceHolder` in `environment-selection.ts`), so that a branch another run is using is never switched.
4. **Freshness of the nested `.paperclip-repositories` worktrees.** Task 3 updates their base clones. A worktree that already exists keeps its own HEAD (`workspaces.ts:552`).
