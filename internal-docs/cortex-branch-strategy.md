# Cortex — Git Branch Strategy

**Product:** Cortex Intelligence Layer
**Status:** Implemented at `github.com/Cov12/cortex`
**Date:** 2026-05-01
**Author:** Coda
**Related:** `cortex-bayesian-engine-spec.md`, `agencyos-technical-architecture.md` §11.4 (predecessor model)

---

## 1. Repos

| Role | Repo | Default branch |
|---|---|---|
| Upstream | `github.com/paperclipai/paperclip` | (paperclip's default) |
| Fork | `github.com/Cov12/cortex` | `master` |

Cortex is a hard fork of Paperclip with WBIT-specific code layered on top. The fork is private to WBIT; upstream stays untouched.

---

## 2. Branch Model (3-Branch + master)

```
paperclip (upstream)
   ↓
master (mirrors paperclip default)
   ↓
upstream-sync → integration (CI) → wbit-cortex-prod (deploys)
```

| Branch | Purpose | Who writes here | Deploys? |
|---|---|---|---|
| `master` | Tracks paperclip upstream — sync target for `git fetch upstream` | Pull-only from upstream | No |
| `upstream-sync` | Pure mirror of `master`, zero custom code | Fast-forwards from `master` | No |
| `integration` | Custom WBIT code + merge testing + CI | Active development | No (preview) |
| `wbit-cortex-prod` | Stable release branch — auto-deploys | Promotion only, tagged | **Yes** |

**Hard rules:**
- `wbit-cortex-prod` only ever receives merges from `integration` (linear history, tagged).
- Upstream changes flow `master` → `upstream-sync` → `integration` → `wbit-cortex-prod`. Never skip a hop.
- `upstream-sync` carries **zero** custom code — this is what makes upstream conflicts clean.
- Every promotion to `wbit-cortex-prod` is tagged: `cortex@vX.Y.Z`.

---

## 3. Workflows

### 3.1 Pulling upstream changes (paperclip → `master` → `upstream-sync`)

```bash
git checkout master
git fetch upstream
git merge --ff-only upstream/<paperclip-default>
git push origin master

git checkout upstream-sync
git merge --ff-only master
git push origin upstream-sync
```

If `--ff-only` fails on either step, something custom landed where it shouldn't have. Investigate before forcing.

### 3.2 Reconciling upstream into custom code (`upstream-sync` → `integration`)

```bash
git checkout integration
git merge upstream-sync          # conflicts resolved here, never on master/upstream-sync
pnpm test && pnpm build
git push origin integration
```

CI on `integration` is the gate. Conflicts get resolved here exactly once per upstream pull.

### 3.3 Promoting to production (`integration` → `wbit-cortex-prod`)

```bash
git checkout wbit-cortex-prod
git merge --ff-only integration
git tag cortex@vX.Y.Z
git push origin wbit-cortex-prod --tags
```

Auto-deploy fires on `wbit-cortex-prod` push. `--ff-only` enforces that nothing has been committed directly to prod.

### 3.4 Hotfix (production-only urgent fix)

```bash
git checkout -b hotfix/<slug> wbit-cortex-prod
# fix, test, commit
git checkout wbit-cortex-prod && git merge --ff-only hotfix/<slug>
git checkout integration && git merge hotfix/<slug>     # back-port immediately
git tag cortex@vX.Y.(Z+1)
```

**Always back-port to `integration` in the same session.** Hotfixes that don't get back-ported reappear on the next promotion and cause merge headaches.

---

## 4. Why 3 branches (inherited from AgencyOS)

The buffer between `upstream-sync` and `wbit-cortex-prod` exists so that:

1. **Upstream conflicts are resolved exactly once**, on `integration`, not repeatedly on the production branch.
2. **CI runs against the merged result before it's eligible for production** — green `integration` is the contract for promotion.
3. **`upstream-sync` stays clean enough to diff against paperclip directly**, which is invaluable when paperclip ships a security patch and you need to confirm it's in your tree.

See `agencyos-technical-architecture.md` §11.4 for the original rationale — it transfers cleanly because Cortex inherits the same upstream-tracking problem from Paperclip that AgencyOS had with OpenWebUI.

---

## 5. Operational Notes

- **Tag scheme:** `cortex@vMAJOR.MINOR.PATCH`. Bump PATCH for hotfixes, MINOR for feature merges, MAJOR for breaking changes (DB migration, API contract change).
- **Branch protection (recommended on GitHub):**
  - `wbit-cortex-prod`: require linear history, no force pushes, restrict pushes to Cov + Coda.
  - `master`, `upstream-sync`: no force pushes.
- **Never rebase shared branches.** Merge only, even when it produces a "merge commit" — preserves upstream provenance.
