# Shared Codex Skill Homes Implementation Plan

> Delivery (2026-11-19): shipped as one standalone pull request from `master` (branch `perf/shared-skill-homes`), independent of PR #22152. References to #22152 below record how the work started; this branch does not contain or need its commits.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Native Codex sessions on Mac/Linux read their assigned skills from one sealed, content-addressed skill home per skill set (passed as the app-server `HOME`) instead of copying them into every session's `CODEX_HOME/skills`.

**Architecture:** A runner-side store module publishes `skill-homes/<digest>/.agents/skills/...` once (stage, seal, atomic rename) and verifies it by manifest on reuse. The Codex transport passes that directory as `HOME` and grants it read-only; the session's `codex-home` keeps the conversation plus a small marker naming the digest. A server-side sweep removes homes no marker references.

**Tech Stack:** TypeScript (Node), Vitest, `packages/paperclip-runner`, `server`.

**Spec:** `doc/plans/2026-11-18-shared-codex-home-caches.md` (approved 2026-11-18).

## Global Constraints

- Branch `feat/shared-codex-skill-homes`, stacked on `fix/expire-local-provider-homes` (PR #22152, which carries the plugin quick fix `dbabe81f4a` and the expiration sweep). PR base: that branch until #22152 merges, then `master`.
- Store root: `<instance>/runtime/paperclip-runner/skill-homes/`, a sibling of `durable-sessions/` (server computes it as `resolve(runnerdStateBase(), "..", "skill-homes")`).
- Skill homes are used only when all hold: provider `codex`, `homeMode` isolated, no `runnerFilesystemRoot` (local runner), `process.platform !== "win32"`, store root option present. Everything else keeps today's copy into `CODEX_HOME/skills`.
- Never trust timestamps for integrity; check membership, regular files, no links, size and sha256.
- No symlinks, hardlinks or junctions anywhere in a skill home.
- No new timers or workers; GC runs inside the existing native harness expiration pass.
- Tests that seal files (`chmod`) fail on Windows with `EPERM fchmod` (pre-existing). Run Vitest in WSL: `node skills/paperclip-wsl/scripts/paperclip-wsl.mjs exec ...` against a Linux worktree of this branch (Task 0). One test file at a time.
- `skills` is **not** added to `CODEX_HOME_CHECKPOINT_EXCLUDED_ENTRIES`: recovery of non-qualified (e.g. Windows) sessions relies on retained `codex-home/skills`. With a skill home it only holds Codex's `.system` skills (~0.4 MB). (Spec deviation, decided while planning; the spec is updated in Task 5.)

## Review Focus

1. Two launches of the same session racing on a brand-new digest: exactly one home is published, the loser discards its staging directory and both start.
2. A home deleted by GC between a launch's verify and its app-server start: GC must not remove a home whose marker was written before the re-check; a launch that finds the home gone republishes.
3. Resume of a session created before this change (has `codex-home/skills/`, no marker): fresh launch moves it to a skill home and explicit skill inputs resolve to the new path.
4. Recovery/reattach of a session whose recorded home failed verification and whose runtime context is unavailable: fails with `codex_skill_home_unavailable`, never starts without skills.
5. Store root on a different filesystem from staging (rename across devices): staging must live inside the store root so `rename` is atomic.

---

### Task 0: Linux worktree for running tests

- [ ] **Step 1:** Commit the plan and design on the branch with Windows Git, push to `origin feat/shared-codex-skill-homes`.
- [ ] **Step 2:** In WSL, create a separate worktree (do not touch the user's `develop` checkout): `node skills/paperclip-wsl/scripts/paperclip-wsl.mjs exec bash -lc 'cd ~/Projects/paperclip && git fetch origin feat/shared-codex-skill-homes && git worktree add ~/Projects/paperclip-skill-homes origin/feat/shared-codex-skill-homes && cd ~/Projects/paperclip-skill-homes && pnpm install --frozen-lockfile --prefer-offline'`. Expected: install completes.
- [ ] **Step 3:** For each later test run: push from Windows, then `git -C ~/Projects/paperclip-skill-homes pull --ff-only` and run the single test file there with `npx vitest run <file>`.

### Task 1: Skill home store (runner)

**Files:**
- Create: `packages/paperclip-runner/src/drivers/codex-skill-home.ts`
- Test: `packages/paperclip-runner/src/drivers/codex-skill-home.test.ts`

**Interfaces:**
- Consumes: `materializeNativeRuntimeSkills(context, skillsHome)` from `runtime-context-materializer.ts` (publishes into a fresh destination and seals each skill); `NativeRuntimeContextSnapshot`.
- Produces:
  - `CODEX_SKILL_HOME_LAYOUT = "paperclip.codex-skill-home.v1"`
  - `codexSkillHomeDigest(context: NativeRuntimeContextSnapshot): string` (64 hex): sha256 of canonical JSON `{ layout, skills: [{ runtimeName, bundleDigest }] }` sorted by `runtimeName`.
  - `ensureCodexSkillHome(input: { storeRoot: string; context: NativeRuntimeContextSnapshot }): Promise<{ home: string; digest: string; created: boolean }>`; `home = <storeRoot>/<digest>`, skills under `<home>/.agents/skills/<runtimeName>`.
  - `verifyCodexSkillHome(home: string): Promise<void>`: throws `Error("codex_skill_home_integrity_failed")`.
  - `writeCodexSkillHomeMarker(codexHome: string, digest: string): Promise<void>` and `readCodexSkillHomeMarker(codexHome: string): Promise<string | null>`. Marker file `<codexHome>/paperclip-skill-home.json` = `{"schema":"paperclip.codex-skill-home-ref.v1","digest":"<64 hex>"}`; a malformed marker reads as `null`.
  - `touchCodexSkillHome(storeRoot: string, digest: string): Promise<void>`: writes `<storeRoot>/<digest>.last-used` (mtime = now), outside the sealed tree.

- [ ] **Step 1: Write the failing tests** in `codex-skill-home.test.ts` (fixtures: two small bundle dirs with `SKILL.md` + `scripts/run.sh`, a context with `runtimeName`s `alpha`, `beta`):
  - `publishes one home for the same skills`: two `ensureCodexSkillHome` calls → same `home`, `created` true then false; `<home>/.agents/skills/alpha/SKILL.md` exists; `readdir(storeRoot)` holds one digest dir (ignore `*.last-used`); files are mode `& 0o222 === 0`.
  - `uses a new home for a new bundle digest`: change `beta`'s `bundle.digest` → different `home`.
  - `digest ignores bundle paths`: same digests, different `rootPath` → same digest.
  - `detects tampering on reuse` (`it.each`): (a) same-size edit of `SKILL.md` with `utimes` restored, (b) extra file, (c) missing file, (d) file replaced by a symlink. After tampering (make writable first), `ensureCodexSkillHome` returns `created: true`, the tampered tree is under `<storeRoot>/quarantine/`, and the new home verifies.
  - `parallel publication yields one home`: `Promise.all` of two `ensureCodexSkillHome` on an empty store → both resolve to the same `home`, exactly one `created: true`, no `.staging-*` left.
  - `marker round-trip`: write then read returns the digest; garbage JSON → `null`; missing → `null`.
- [ ] **Step 2: Run:** `npx vitest run src/drivers/codex-skill-home.test.ts` (in WSL worktree, `packages/paperclip-runner`). Expected: FAIL, module not found.
- [ ] **Step 3: Implement** `codex-skill-home.ts`. Staging dir `<storeRoot>/.staging-<uuid>/`, materialize into `<staging>/.agents/skills` with `materializeNativeRuntimeSkills`, write `<staging>/manifest.json` (`{ layout, digest, files: [{ path, size, sha256 }] }`, paths POSIX-relative, sorted), chmod `.agents`, staging dir and manifest read-only, then `rename(staging, home)`. On `ENOTEMPTY`/`EEXIST`: remove the staging copy (restore write bits first, reuse `releaseMaterializedNativeRuntimeSkills`-style unprotect), then verify the existing home. Verification walks with `lstat`, rejects non-regular entries, compares the sorted file list and hashes against the manifest. On failure rename the home to `<storeRoot>/quarantine/<digest>.<Date.now()>.<uuid>` and publish again (once; a second failure throws).
- [ ] **Step 4: Run** the same command. Expected: all PASS.
- [ ] **Step 5: Commit** `feat(runner): add a content-addressed Codex skill home store`.

### Task 2: Launch wiring (runner)

**Files:**
- Modify: `packages/paperclip-runner/src/drivers/runtime-context-materializer.ts` (`prepareIsolatedCodexHome`)
- Modify: `packages/paperclip-runner/src/live/runner-provider-launch.ts` (`createRunnerdCodexAppServerArgs`, the codex `readOnlyRoots` at ~398)
- Modify: `packages/paperclip-runner/src/live/runnerd-codex-transport.ts` (options type ~1699; env `HOME` ~3962; fresh launch ~6292; reattach args ~7223; recovery ~7419; explicit skill path ~9928)
- Test: `packages/paperclip-runner/src/drivers/codex-skill-home-launch.test.ts`; extend `packages/paperclip-runner/src/live/runner-provider-launch.test.ts` (or the existing test that covers `createRunnerdCodexAppServerArgs`; find it with `grep -rln createRunnerdCodexAppServerArgs src --include=*.test.ts`)

**Interfaces:**
- Consumes: Task 1 exports.
- Produces:
  - Transport option `codexSkillHomeStoreRoot?: string` on `CapabilityRunnerdCodexTransportOptions`.
  - `usesCodexSkillHome(options: { provider: string; homeMode?: "isolated" | "preconfigured"; runnerFilesystemRoot?: string; codexSkillHomeStoreRoot?: string }, platform = process.platform): boolean`, exported from `codex-skill-home.ts`.
  - `prepareIsolatedCodexHome(input)` gains `skillHomeStoreRoot?: string` and returns `Promise<{ skillHome: string | null }>`. With a store root and a non-null context: `ensureCodexSkillHome`, `writeCodexSkillHomeMarker`, `touchCodexSkillHome`, and **no** `codexHome/skills` materialization. Without: today's behavior, returns `{ skillHome: null }`.
  - `resolveRecordedCodexSkillHome(input: { codexHome: string; storeRoot: string; context: NativeRuntimeContextSnapshot | null }): Promise<string>`: marker digest → verified home; missing/failed → republish from `context` (digest must equal the marker's), else throw `Error("codex_skill_home_unavailable")`.
  - `createRunnerdCodexAppServerArgs` gains `skillHome?: string`: when set, policy `HOME` = `skillHome` (still denied) and `resolve(skillHome, ".agents", "skills")` is a read-only root in place of `resolve(codexHome, "skills")`.

- [ ] **Step 1: Write the failing tests** in `codex-skill-home-launch.test.ts`:
  - `two sessions with the same skills store the bytes once`: two `prepareIsolatedCodexHome({ context, codexHome: <a|b>, skillHomeStoreRoot })` → same `skillHome`; neither `<a>/skills/alpha` nor `<b>/skills/alpha` exists; total bytes of regular files under `storeRoot` + `a` + `b` < 1.5 × one skill set. This is the spec's red/green proof; on current code it fails (skills copied into each home).
  - `keeps copying without a store root`: no `skillHomeStoreRoot` → `<a>/skills/alpha/SKILL.md` exists, `skillHome === null`.
  - `recovery reuses the recorded home` / `republishes a deleted home` / `fails without context` (`codex_skill_home_unavailable`) for `resolveRecordedCodexSkillHome`.
  - `usesCodexSkillHome` table: false for `win32`, `preconfigured`, a `runnerFilesystemRoot`, a missing store root, provider `acpx`; true otherwise.
  - `migrates an old-layout session`: a `codexHome` that already has `skills/alpha` and no marker → after a fresh-launch `prepareIsolatedCodexHome` with a store root, `skills/alpha` is gone, the marker names the digest, and the explicit skill input for `alpha` (via the transport's exported explicit-skill helper, or the existing explicit-skill test file) resolves to `<skillHome>/.agents/skills/alpha/SKILL.md`.
  - In the args test: with `skillHome` set, the filesystem policy string contains `"<skillHome>/.agents/skills"="read"` and `"<skillHome>"="none"`, and does not contain `"<codexHome>/skills"="read"`.
- [ ] **Step 2: Run** both test files (one at a time). Expected: FAIL.
- [ ] **Step 3: Implement.** In the transport, compute `skillHome` once per launch when `usesCodexSkillHome(...)`:
  - fresh launch (~6292): pass `skillHomeStoreRoot` to `prepareIsolatedCodexHome`; keep the existing `releaseMaterializedNativeRuntimeSkills` call (it migrates old sessions);
  - recovery (~7419): after `prepareIsolatedCodexRecoveryHome`, call `resolveRecordedCodexSkillHome` when a marker exists; no marker → today's behavior;
  - maintenance (~3058, `context: null`): unchanged, `skillHome` null;
  - env `HOME` (~3962) and both `createRunnerdCodexAppServerArgs` calls (`runner-provider-launch.ts` ~387, transport ~7223) use `skillHome ?? codexHome`;
  - explicit skill path (~9928): `resolve(skillHome, ".agents", "skills", runtimeName, "SKILL.md")` when `skillHome` is set.
- [ ] **Step 4: Run** the two test files, then the existing `runtime-context-materializer.test.ts` and the transport's explicit-skill test file. Expected: PASS (Windows-only `EPERM` cases do not apply in WSL).
- [ ] **Step 5: Commit** `feat(runner): launch Codex with a shared skill home as HOME`.

### Task 3: Server passes the store root

**Files:**
- Modify: `server/src/services/native-runtime/native-session-executor.ts` (transport options near `homeMode: preconfiguredHome ? ...` ~18708; export a helper near `runnerdStateBase` ~2635)
- Test: `server/src/services/native-runtime/codex-skill-home-store-root.test.ts`

**Interfaces:**
- Produces: `export function codexSkillHomeStoreRoot(): string` = `resolve(runnerdStateBase(), "..", "skill-homes")`; transport option `codexSkillHomeStoreRoot` set for local (`!remoteTarget`) Codex launches with isolated homes.

- [ ] **Step 1: Write the failing test:** with `PAPERCLIP_RUNNER_STATE_DIR=/x/runtime/paperclip-runner/durable-sessions`, `codexSkillHomeStoreRoot()` returns `/x/runtime/paperclip-runner/skill-homes`; with it unset it ends in `runtime/paperclip-runner/skill-homes` under the instance root.
- [ ] **Step 2: Run** `npx vitest run src/services/native-runtime/codex-skill-home-store-root.test.ts` (in `server/`). Expected: FAIL.
- [ ] **Step 3: Implement** the helper and the option (`...(input.execution.provider.kind === "codex" && !preconfiguredHome && !remoteTarget ? { codexSkillHomeStoreRoot: codexSkillHomeStoreRoot() } : {})`).
- [ ] **Step 4: Run** the test, then `npx tsc --noEmit -p server/tsconfig.json`. Expected: PASS, no errors.
- [ ] **Step 5: Commit** `feat(native-runtime): give local Codex runs the shared skill home store`.

### Task 4: Garbage collection in the expiration sweep

**Files:**
- Create: `server/src/services/native-runtime/codex-skill-home-retention.ts`
- Modify: `server/src/services/native-runtime/native-harness-backup-expiration.ts` (one call per pass, after the sessions phase; add `skillHomesRemoved`, `skillHomeReclaimedBytes` to the result type)
- Modify: runner package index (`packages/paperclip-runner/src/index.ts` or the entry `server/src/vendor/paperclip-runner/index.ts` re-exports) to export `readCodexSkillHomeMarker`
- Test: `server/src/services/native-runtime/codex-skill-home-retention.test.ts`

**Interfaces:**
- Consumes: `readCodexSkillHomeMarker` (Task 1).
- Produces: `sweepCodexSkillHomes(input: { storeRoot: string; sessionsRoot: string; now: number; graceMs?: number /* default 24 h */; dryRun?: boolean; maxRemovals?: number /* default 50 */ }): Promise<{ removed: number; reclaimedBytes: number; kept: number }>`.

- [ ] **Step 1: Write the failing tests:**
  - keeps a home named by `sessionsRoot/<64hex>/codex-home/paperclip-skill-home.json`;
  - keeps an unreferenced home whose `<digest>.last-used` is newer than `now - graceMs`;
  - removes an unreferenced, expired home and its `.last-used`, reports bytes;
  - a marker that appears after the rename to `.retiring-<uuid>` (simulate with a hook/second marker written before re-check) restores the home instead of deleting it;
  - removes leftover `.staging-*` and `.retiring-*` older than `graceMs`; never touches `quarantine/` contents newer than 7 days;
  - `dryRun` removes nothing; expiring a session's `codex-home` (delete the dir) makes its home removable on the next sweep past grace.
- [ ] **Step 2: Run** the test. Expected: FAIL.
- [ ] **Step 3: Implement.** Sealed trees need write bits restored before `rm` (walk and `chmod` like `unprotectMaterializedTree`). Wire one call into the expiration pass using `codexSkillHomeStoreRoot()` and `runnerdStateBase()`, honoring the pass's existing `dryRun` and `shouldContinue`.
- [ ] **Step 4: Run** this test and `native-harness-backup-expiration.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(native-runtime): remove unreferenced Codex skill homes`.

### Task 5: Measurement, docs, PR

**Files:**
- Create: `packages/paperclip-runner/scripts/benchmark-codex-skill-homes.mjs`
- Create: `doc/benchmarks/2026-11-18-shared-codex-skill-homes.md`
- Modify: `doc/recoverable-disk-cleanup.md` (skill homes and their sweep), `doc/plans/2026-11-18-shared-codex-home-caches.md` (checkpoint-exclusion deviation)

- [ ] **Step 1:** Benchmark script: takes a store root, a temp root and N bundle dirs; runs `prepareIsolatedCodexHome` twice into two fresh `codex-home`s (a) without and (b) with `skillHomeStoreRoot`, reporting per run wall time, bytes in each `codex-home`, bytes in the store, and a warm third run for (b). Uses the largest skill set from the WSL instance's `runtime-context-assets/bundles` (read-only source).
- [ ] **Step 2:** Run it in WSL; record numbers, machine, Codex version and skill-set size in the benchmark doc.
- [ ] **Step 3:** Real-turn check (ask the user first: it needs their Codex login copied into a temp `CODEX_HOME` inside WSL). Start Codex 0.160 `app-server` with `HOME=<skill home>`, run one turn that reads `scripts/run.sh` of an assigned skill; confirm the turn succeeds and `find <skill home> -newer <manifest.json>` is empty. Record the result.
- [ ] **Step 4:** `pnpm verify` in the WSL worktree. If it exits 2, run the touched test files and rely on CI.
- [ ] **Step 5:** Commit docs, push, open the PR stacked on `fix/expire-local-provider-homes` (upstream `paperclipai/paperclip`, head `feat/shared-codex-skill-homes` from the fork) filling every section of `.github/PULL_REQUEST_TEMPLATE.md`, including Model Used. Then bind it with the ccd_pr tools and read its CI.
