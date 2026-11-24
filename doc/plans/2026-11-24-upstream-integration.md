# Upstream Integration Plan

- **Date:** 2026-11-24
- **Status:** proposed (not started)
- **Base branch:** `master` @ `046aeeb9f2`
- **Upstream ref:** `upstream/master` (paperclipai/paperclip)
- **Merge base:** `5555817c2b18a1a5ebc3a3b01883c1b12b86df5a` (2026-10-16)

## 1. Situation (evidence)

| Fact | Value |
|---|---|
| Upstream commits since fork point | 3,186 |
| Fork-only commits | 27 (4 logical features + CI fixes + docs-only) |
| Net tree diff | 10,994 files changed (+1.56M / −295K lines) |
| Upstream status counts | 6,958 added / 3,531 modified / 503 deleted / 2 renamed |
| Upstream commit mix | 1,966 fix · 314 perf · 277 feat · 257 test · 55 docs · 39 refactor |
| Migration gap | fork ends at 0354 (+ local 0355_two_factor_auth); upstream ran 0355→0504 = **150 migrations ahead** (idx 355 through 504 inclusive) |
| Migration number collision | upstream `0355_agent_tool_definition_hooks.sql` vs fork `0355_two_factor_auth.sql` — **guaranteed double-claim** |
| Dry-run merge conflicts | ~16 paths (see §5) |
| Workspace versions | identical both sides (cli + shared `0.3.1`) — gap is unreleased upstream work |

### Key classifications (verified)

- **Pipelines** (`cli/src/commands/pipelines.ts`, `docs/pipelines-tutorial.md`, `doc/execution-semantics.md`): existed in upstream at fork point, **deliberately removed upstream** in `9077748894` (#16834 "Remove the Pipelines experiment and preserve its data"). Not our feature.
- **SPEC docs** (`doc/SPEC.md`, `doc/SPEC-implementation.md`): existed at fork point, **deliberately removed upstream** in `9b21dcbdda` (#20565 "remove SPEC docs and repoint spec citations"). Our AGENTS.md still cites `doc/SPEC-implementation.md` as the V1 contract — it will be upstream's repointed version post-integration.
- **EYW engine fixes** (Codex context bound EYW-692, opencode compact-on-resume EYW-797, pi-local E2BIG guard): **no upstream equivalents** (grep of 3,186 commits for E2BIG / context overflow / compact-on-resume = zero hits). Unique fork value.
- **2FA schema content**: no upstream migration touches `two_factor` / `backup_code` / `tfa_` tables — collision is numbering-only, resolvable by renumber.
- **`packages/db/src/schema/auth.ts`**: auto-merges cleanly *textually* in dry-run merge (content diverged but non-conflicting). Note: upstream migration `0465_better_auth_account_identity.sql` changes `account.issuer` nullability — semantic verification required in Stage 3 (step 2b) even though the textual merge is clean.
- **`qrcode` dependency**: fork-only ui dependency (upstream dropped it). Travels with the 2FA unit.
- Fork's `pnpm-lock.yaml` was regenerated against the **October** upstream base (`6f6992bfcf`); upstream's lockfile has moved far since → lockfile conflicts are baseline-staleness, not real dependency disagreement.

## 2. Strategy decision

**Rebase-forward integration:** new master = `upstream/master` + fork feature units cherry-picked on top. Do **not** `git merge upstream/master` into current master.

| Option | Verdict |
|---|---|
| `git merge upstream/master` into master | One mega-conflict session over a stale lockfile baseline; fork commits stay below upstream commits in history; every future upstream sync re-merges the same 3,186-commit context. **Rejected.** |
| Cherry-pick units onto `upstream/master` | Small feature-coherent conflict contexts; each file resolved once; future upstream syncs become nearly conflict-free merges. **Chosen.** |
| PR each feature to upstream first | Correct if features are headed upstream long-term (units are PR-shaped after Stage 1) but blocks local catch-up. Can be combined **after** integration. |

## 3. Pre-flight decisions (answer before Stage 1)

| # | Decision | Default |
|---|---|---|
| D1 | Accept upstream deletion of `doc/SPEC.md` + `doc/SPEC-implementation.md` (#20565 repointed citations)? Fork's 2FA work modified SPEC-implementation.md — those edits are discarded. | **Yes** (upstream's doc reorg was deliberate) |
| D2 | Accept upstream removal of the Pipelines experiment (#16834)? | **Yes** (upstream product decision) |
| D3 | Commit the Chief Engineer test (`server/src/services/native-run-mcp*` test head) + 2 untracked plan docs into the new master? | **Yes** (our work artifacts) |
| D4 | Force-push (`--force-with-lease`) origin/master at cutover? Requires explicit confirmation per repo safety rules. | **No** — tag + backup branch first, decide then |
| D5 | Which `AGENTS.md` wins post-integration? Fork's is rule-heavy (linear read-order + scoped-rules table + three-data-paths rule + token-gate rule); upstream's is philosophy-first ("code and its tests are the source of truth"). Cherry-picking onto upstream/master means upstream's version lands by default, silently dropping our fork-specific rules. Same question applies to `rules/*.mdc` (verify whether they exist upstream). | **Upstream's wholesale**, then append a new "Fork-specific local rules" section containing the three-data-paths rule, token-gate rule, and scoped-rules table. Verify `rules/*.mdc` presence in upstream before Stage 2. |

## 4. Execution stages

### Stage 0 — Prep on current master (~15 min)

1. Clean the working tree:
   - commit `packages/db/src/migrations/meta/0355_snapshot.json` (fixes broken committed journal state)
   - commit `.gitignore` (agent-runtime ignores already added)
   - per D3: commit or discard the Chief Engineer test + 2 plan docs
   - delete junk files (`errorCode`, `issueId=`) + `packages/mcp-server/err*.log`
2. Backup:
   ```sh
   git tag pre-upstream-master-20261124
   git branch backup/master-pre-upstream-20261124
   ```

### Stage 1 — Flatten + squash into 7 units (~30 min, mechanical)

```sh
git checkout -B stage/flatten master
git rebase -i 5555817c2b18a1a5ebc3a3b01883c1b12b86df5a
# default rebase flattens the 3 merge commits (af8fc71ae8, 5692dcde81, 93f8486584);
# 24 non-merge commits remain to reorder/squash
```

Reorder into unit order, squash as marked:

| Order | Unit | Source commits → result |
|---|---|---|
| 1 | opencode compact-on-resume (EYW-797) | `5c0aa2aa48` → keep |
| 2 | pi-local E2BIG guard | `172f2b6359` → keep |
| 3 | Codex context bound (EYW-692) | `046aeeb9f2` → keep |
| 4 | Hermes symlink repair | `7f5ca63349` → keep |
| 5 | Cyclic-blocker drop | `35149b7d3c` → keep |
| 6 | CI refresh-lockfile fixes | `05b56b2c0a` + `91e56515df` → **squash to 1** |
| 7 | **Two-factor auth** (TOTP + backup codes) | 13 commits `4266b79bf2` → `95e375d774` (incl. docs-only `86938e0a7a`, `84cd579bb8`, `8035a3b221`, `ccb015a387` and dep commit `6f6992bfcf`) → **squash to 1** |
| 8 | **Google SSO** | `43b6441b89`, `d5f8809868`, `4e3d8d5b11`, `571f64f5a4` → **squash to 1** |

**Rebase mechanics note:** The 24 non-merge commits replay onto `5555817c` in first-parent order. Unit 7's 13 commits are stacked (each `fix` depends on the `feat` below it) — keep `4266b79bf2` as `pick` and mark the other 12 as `squash` so the first commit's message becomes the unit title. Unit 8's `43b6441b89` (openspec planning docs) adds `openspec/changes/add-google-sso/` files that upstream has never had; it's pure-add and will cherry-pick cleanly, but consider dropping it from Unit 8's squash (mark `drop` in the rebase todo) if you don't want to carry openspec artifacts into the integrated master.

**Inside Unit 7's squash, renumber the migration** (this is what makes the journal conflict trivial):

- `packages/db/src/migrations/0355_two_factor_auth.sql` → `0505_two_factor_auth.sql`
- `packages/db/src/migrations/meta/0355_snapshot.json` → `0505_snapshot.json`
- `meta/_journal.json`: entry idx `355` → `505`, tag → `0505_two_factor_auth`

Why: upstream's journal ends at idx 504, so Unit 7's journal diff becomes a pure *append-one-entry* → auto-merges. No double-claim at 0355 (upstream's 0355 is `agent_tool_definition_hooks`).

### Stage 2 — Cherry-pick onto upstream (~half day)

```sh
git fetch upstream
git checkout -B integrate/upstream-20261124 upstream/master
git cherry-pick <unit commits from stage/flatten, in order 1→8>
```

**Conflict expectations per unit** (from the `git merge-tree --write-tree` dry-run):

| Unit | Expected conflicts | Resolution notes |
|---|---|---|
| 1–3 (EYW) | `packages/adapters/opencode-local/src/server/{execute.ts,index.ts}` + `session-compaction.ts` + `models.ts`, `packages/adapters/pi-local/src/server/execute.ts` + `src/index.ts`, **`packages/adapter-utils/src/acpx-engine/{execute.ts,accounting-model.ts}`** (hottest conflict — upstream added 504 lines to `execute.ts` beside the file our EYW-692 work extends) | Combine our guards with upstream's newer logic. `accounting-model.ts` is **not** a clean add — it exists in base, fork (36 lines), and upstream (10 lines, rewritten in `1b4c803816`); expect a content conflict during cherry-pick and resolve by combining both sides' logic. `acpx-engine/execute.ts` will need careful manual merge. Verify against EYW issue context |
| 4–5 | `server/src/services/issues.ts` (cyclic fix), hermes adapter files | Small, isolated |
| 6 (CI) | `.github/workflows/refresh-lockfile.yml` | Take our REST-based version if upstream's still uses gh CLI |
| 7 (2FA) | `packages/shared/src/validators/index.ts`, `packages/shared/src/index.ts`, `server/src/auth/better-auth.test.ts`, `ui/src/pages/Auth.tsx` + `Auth.test.tsx`, `ui/src/pages/ProfileSettings.tsx`, `pnpm-lock.yaml`; **delete-vs-modify:** `ui/src/pages/ProfileSettings.test.tsx` (upstream deleted, we modified) | Auth stack is the bulk. `ProfileSettings.test.tsx`: **keep the fork's version** — the test is additive 2FA UI coverage that upstream's deletion did not anticipate. Note in the cherry-pick resolution comment. `pnpm-lock.yaml`: take upstream's, then run `pnpm install` to re-add `qrcode` from `ui/package.json` (fork-only dep; upstream dropped it but our 2FA QR feature needs it at runtime). `_journal.json` should auto-merge post-renumber. `auth.ts` schema auto-merges cleanly **textually**, but upstream migration `0465_better_auth_account_identity.sql` makes `account.issuer` nullable and adds `account_provider_account_id_uq` — our 2FA index/defaults on the `account` table must be re-verified against that change in Stage 3 (see §4 Stage 3 step 2b). |
| 8 (SSO) | `ui/src/pages/Auth.tsx` (again), `server/src/auth/better-auth.ts` (likely auto), validators (settled by Unit 7) | Small once 2FA has landed |

**Order rationale:** EYW/engine first (independent), then small fixes, CI, then 2FA, then SSO last — SSO and 2FA share the auth files; SSO's context is cleanest after 2FA has settled them.

### Stage 2.5 — Reconcile governance docs (per D5)

Cherry-picking onto `upstream/master` means **upstream's `AGENTS.md` is what lands** by default. Fork-specific governance rules (three-data-paths rule, token-gate rule, scoped-rules table for `rules/*.mdc`) are silently dropped unless re-added explicitly.

1. `diff` our `AGENTS.md` against upstream's post-cherry-pick version. Identify the fork-specific sections that upstream lacks.
2. Apply D5: take upstream's `AGENTS.md` wholesale, append a new **"Fork-specific local rules"** section containing:
   - The three-data-paths rule (telemetry vs observability vs run log)
   - The token-gate rule (`pnpm check:token-gates`)
   - The scoped-rules table pointing at `rules/*.mdc`
   - The `DESIGN.md` design-system paragraph (verify whether upstream's AGENTS.md already has it; add if not)
3. Verify `rules/*.mdc` exists in upstream. If upstream has its own `rules/` directory, merge the fork-specific `.mdc` files into it (don't overwrite upstream's files). If upstream has no `rules/` directory, ours lands cleanly with the cherry-pick.
4. Amend into the last cherry-picked unit commit, or make a dedicated `docs(governance): reconcile AGENTS.md and rules post-integration` commit on top of the 8 units.
5. Re-run `node scripts/check-maps.mjs` (the maps contract may have shifted).

### Stage 2.75 — Early-exit typecheck gate

Before the full Stage 3 verification, run:

```sh
pnpm -r typecheck
```

This is a ~2-minute check that catches structural breakage (missing imports, type mismatches, dangling references) before committing 1–2 hours to `pnpm test:run` + `pnpm build`. A typecheck failure at Unit 7 is a 2-minute fix; the same failure discovered after the full-suite run is a much longer debug session. If typecheck fails, fix the specific unit and re-run. Do not proceed to Stage 3 step 2 (migration proof) until typecheck is green.

### Stage 3 — Verify against repo gates

1. `pnpm install` → regenerates `pnpm-lock.yaml` on the upstream dependency base, re-adding `qrcode` from `ui/package.json` (fork-only dep; upstream dropped it but our 2FA QR feature needs it at runtime). Verify `qrcode` is present in the regenerated lock: `grep -c '"qrcode"' pnpm-lock.yaml` → expect ≥1. Then `git add pnpm-lock.yaml && git commit --amend` into Unit 7 (or separate `chore(deps)` commit)
2. **Migration proof (decisive test):** `rm -rf data/pglite && pnpm dev` → embedded PGlite must apply upstream's 0355→0504 then our 0505 without error
2b. **`account` table semantic check:** upstream migration `0465_better_auth_account_identity.sql` makes `account.issuer` nullable and adds `account_provider_account_id_uq`. After the DB boots, run `psql` (or `drizzle studio`) and confirm our 2FA constraints/indexes on `account` still hold under that change — textual auto-merge of `auth.ts` does not prove semantic compatibility
3. Full hand-off set per AGENTS.md: `pnpm -r typecheck` → `pnpm test:run` → `pnpm build` (browser suites stay opt-in per AGENTS.md §7)
4. `pnpm check:token-gates` (2FA/SSO touched UI) + `node scripts/check-maps.mjs` (upstream changed maps)
5. Behavioral probes on dev instance:
   - 2FA: enroll TOTP → sign-in gate → backup-code recovery path
   - Google SSO: full OAuth round-trip (requires Google OAuth client env vars)
6. **Verify AGENTS.md citations are repointed** (if not already done in Stage 2.5): upstream deleted `doc/SPEC-implementation.md` but our `AGENTS.md` still cited it in 3 places (§1 line 8, §2 line 16, §2 line 21). Stage 2.5 replaces our `AGENTS.md` with upstream's wholesale (which already uses the repointed citations). Confirm no stale `doc/SPEC-implementation.md` references remain in the post-integration `AGENTS.md` before cutover.

### Stage 4 — Cutover

```sh
git branch -f master integrate/upstream-20261124
# old state recoverable via tag pre-upstream-master-20261124 + backup branch
```

- Push to origin: replaces origin/master history → requires `--force-with-lease` → **explicit user confirmation needed** (repo safety rule: never force-push without confirmation).
  - Non-destructive alternative: push `integrate/upstream-20261124` as a branch and PR it against master on the fork.
- Future upstream syncs thereafter: `git fetch upstream && git merge upstream/master` (our commits sit on top → near-zero conflicts).

## 5. Conflict inventory (dry-run `git merge-tree --write-tree master upstream/master`)

~16 paths flagged, clustered in:

1. `packages/db/src/migrations/meta/_journal.json` (git even classifies it "binary" — refuse-to-auto-merge heuristic; resolved trivially by the 0505 renumber)
2. Auth backend: `server/src/auth/better-auth.test.ts`, shared validators/types (`packages/shared/src/validators/index.ts`, `packages/shared/src/index.ts`)
3. UI auth: `ui/src/pages/Auth.tsx`, `Auth.test.tsx`, `ProfileSettings.tsx`, `ProfileSettings.test.tsx` (d/m)
4. Engine adapters: `packages/adapters/opencode-local/src/server/{execute.ts,index.ts}`, `packages/adapters/pi-local/src/server/execute.ts`, **`packages/adapter-utils/src/acpx-engine/{execute.ts,accounting-model.ts}`** (upstream grew `execute.ts` +504 lines alongside `accounting-model.ts`; our EYW-692 work touches both). Note: `accounting-model.ts` is **not** a clean fork-only add — it exists in base, fork (36 lines), and upstream (10 lines, rewritten in `1b4c803816`). It will conflict during cherry-pick, not auto-add.
5. `server/src/services/issues.ts`
6. `.github/workflows/refresh-lockfile.yml`
7. `pnpm-lock.yaml` (baseline staleness)
8. `doc/SPEC-implementation.md` (d/m — resolved by D1)
9. `ui/src/pages/ProfileSettings.test.tsx` (d/m — upstream deleted, fork modified to add 2FA UI tests). **Keep the fork's version** — the test is additive fork work that upstream's deletion did not anticipate. Note in the cherry-pick resolution comment.

## 6. Rollback / safety

- Old master fully preserved at tag `pre-upstream-master-20261124` and branch `backup/master-pre-upstream-20261124` before anything is rewritten.
- `stage/flatten` and `integrate/upstream-20261124` are disposable branches; master is only moved in Stage 4.
- Aborting mid-cherry-pick: `git cherry-pick --abort` returns to upstream/master base; re-run after fixing the specific unit.
- If Stage 3 migration proof fails: the integrated branch is quarantined; master untouched.

## 7. Effort estimate

| Stage | Estimate |
|---|---|
| 0 — prep | ~15 min |
| 1 — flatten/squash | ~30 min (mechanical interactive rebase) |
| 2 — cherry-pick + conflict review | ~half day (16 files across 8 units; auth cluster dominates) |
| 2.5 — governance doc reconciliation | ~15 min (AGENTS.md section merge + `rules/*.mdc` check) |
| 2.75 — early-exit typecheck | ~2 min (gate; re-run after any fix) |
| 3 — verification | ~1–2 h (full test suite + PGlite migration smoke) |
| 4 — cutover | minutes (+ push decision) |
| **Total** | **~1–1.5 days**, dominated by Stage 2. Budget for a second Stage 3 iteration (~20% chance) if the first full-suite run surfaces a regression the early typecheck didn't catch. |

## 8. Follow-on (optional)

After integration, the 7 unit commits are PR-shaped candidates for upstream: 2FA, Google SSO, and the three EYW engine fixes are the strongest candidates (verified unique vs upstream). File as separate PRs per `.github/PULL_REQUEST_TEMPLATE.md` discipline.
