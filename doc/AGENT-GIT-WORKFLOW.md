# Agent Git Workflow Protocol

This document defines the git branching, commit, and code review standards for agent-authored changes to the Paperclip codebase. All agents with write access to this repo must follow these rules.

Related: [ANGA-268](/ANGA/issues/ANGA-268)

---

## Branch Naming

Every agent branch must include the Paperclip issue identifier.

| Type | Pattern | Example |
|------|---------|---------|
| Feature | `feature/anga-{N}-{slug}` | `feature/anga-268-agent-git-workflow` |
| Bug fix | `fix/anga-{N}-{slug}` | `fix/anga-235-clear-run-locks` |
| Chore / docs | `chore/anga-{N}-{slug}` | `chore/anga-270-update-deps` |
| Hotfix to stable | `hotfix/anga-{N}-{slug}` | `hotfix/anga-301-null-ptr` |

Rules:
- `{N}` is the numeric suffix from the Paperclip issue identifier (e.g. `268` from `ANGA-268`).
- `{slug}` is lowercase, hyphen-separated, ≤ 40 characters, derived from the issue title.
- Never commit directly to `master` or `stable`. Branch → PR → merge.

---

## Branch Lifecycle

```
master  ──────────────────────────────────────▶  ongoing development
           │
           └── feature/anga-N-slug  (agent work)
                       │
                       └── PR → code review → merge to master
                                                     │
                                              (periodic tagging)
                                                     │
                                              stable  (tagged release)
```

### `master`

- Primary integration branch.
- All agent feature / fix branches merge here via PR.
- Must pass typecheck + tests + build at all times (`pnpm -r typecheck && pnpm test:run && pnpm build`).

### `stable`

- A periodically promoted snapshot of `master` that has been manually verified to be release-quality.
- Promoted by the board or CTO; do not promote unilaterally.
- Hotfixes branch from `stable`, merge back to both `stable` **and** `master`.

---

## Commit Message Format

Use [Conventional Commits](https://www.conventionalcommits.org/) with a mandatory issue reference:

```
<type>(<scope>): <short summary> (ANGA-N)

[optional body]

Co-Authored-By: Paperclip <noreply@paperclip.ing>
```

### Types

| Type | When |
|------|------|
| `feat` | New capability or behavior |
| `fix` | Bug fix |
| `refactor` | Code restructure without behavior change |
| `test` | Adding or updating tests |
| `chore` | Dependency updates, config, tooling |
| `docs` | Documentation only |
| `perf` | Performance improvement |

### Scope (optional)

Use a package or domain shortname: `server`, `ui`, `db`, `adapters`, `cli`, `plugins`.

### Examples

```
feat(server): add issue heartbeat-context endpoint (ANGA-268)

fix(adapters): clear executionRunId on run termination (ANGA-235)

docs: add agent git workflow protocol (ANGA-268)

Co-Authored-By: Paperclip <noreply@paperclip.ing>
```

### Mandatory fields

1. **Type prefix** — required, from the table above.
2. **Issue reference** — required, in `(ANGA-N)` format, at the end of the subject line.
3. **Co-author trailer** — `Co-Authored-By: Paperclip <noreply@paperclip.ing>` — required on every agent commit.

Do NOT use vague messages like `"WIP"`, `"fix stuff"`, or `"update"`. Write the message so it makes sense standalone in `git log`.

---

## Pull Request Requirements

Every agent branch must go through a PR before merging to `master`.

### PR title

Match the commit format: `type(scope): summary (ANGA-N)`.

### PR description must include

1. **Thinking path** — a top-down explanation (see `CONTRIBUTING.md` for examples).
2. **What changed** — bullet list of files and why.
3. **Verification** — how the change was tested (typecheck / test run output).
4. **Issue link** — `Closes ANGA-N` or `Part of ANGA-N`.

### Who reviews

- Agent PRs are reviewed by the **CTO** (or a designated peer agent if the CTO is the author).
- The CTO must post a structured [Harness Output](/ANGA/agents/cto) comment confirming checks pass before merging.
- Board members may review any PR at any time and their approval takes precedence.

### Merge strategy

- Use **squash merge** for single-commit feature branches.
- Use **merge commit** when preserving individual commits matters (e.g. multi-commit fix series).
- Never fast-forward directly to `master` without a PR.

---

## Commit Traceability

Every commit that touches production code must reference a Paperclip issue. This is non-negotiable.

Commit format reminder:

```
feat(scope): description (ANGA-N)
```

Agents MUST NOT commit without a valid `ANGA-N` (or equivalent company prefix) in the subject line. If work is exploratory and no issue exists yet, create a Paperclip issue first, then commit.

---

## Periodic Review Cadence

| Cadence | Action | Owner |
|---------|--------|-------|
| Each merged PR | CTO reviews Harness Output and verifies checks passed | CTO |
| Weekly (Fridays) | CTO reviews `git log master --since="7 days ago"` for style/quality regressions | CTO |
| Monthly | Board spot-checks 3–5 random agent commits for correctness and scope adherence | Board |
| Per release (stable promotion) | Full audit of commits since last stable tag | CTO + Board |

The CTO must post a weekly review comment on the active sprint milestone issue (or a dedicated review issue) summarizing:
- Number of commits merged
- Any style/quality issues found
- Corrective actions taken

---

## Rollback Runbook

### Scenario A: Revert a single bad commit (not yet pushed to others)

```sh
# Identify the bad commit
git log --oneline master | head -20

# Revert it (creates a new revert commit — never reset --hard on shared branches)
git revert <commit-sha>
# Edit the revert message to include the issue ref: "revert: ... (ANGA-N)"
git push origin master
```

### Scenario B: Revert a merged PR (squash commit)

```sh
# Find the merge commit (or squash commit SHA)
git log --oneline master | grep "ANGA-N"

# Revert that commit
git revert <squash-commit-sha>
git push origin master
```

Then update the Paperclip issue: reopen it, add a comment explaining what was reverted and why.

### Scenario C: Revert multiple commits (a bad feature branch landed via merge commit)

```sh
# Find the merge commit SHA
git log --oneline --merges master | head -10

# Revert the merge commit (specify -m 1 to target the mainline parent)
git revert -m 1 <merge-commit-sha>
git push origin master
```

### Scenario D: Emergency rollback of stable

```sh
# Do NOT force-push stable. Instead, create a new stable tag pointing to the last good commit.
git tag stable-rollback-YYYY-MM-DD <last-good-sha>
git push origin stable-rollback-YYYY-MM-DD

# Board then decides: promote the rollback tag to a new stable, or hotfix forward.
```

### After any rollback

1. Post a comment on the related Paperclip issue explaining: what was reverted, when, and why.
2. Update issue status back to `todo` or `in_progress` as appropriate.
3. Do NOT silently delete branches that produced bad output — keep them for post-mortem.

---

## Enforceability Under Current Tooling

These rules are enforceable by agents because:

1. **Branch naming** — agents create branches via `git checkout -b`. They can verify their branch matches `(feature|fix|chore|hotfix)/anga-\d+-[a-z0-9-]+` before pushing.
2. **Commit messages** — agents write commit messages; the `(ANGA-N)` trailer and `Co-Authored-By` line are appended by convention (no hook required, though a commit-msg hook can be added later).
3. **PR gate** — Paperclip issues require an agent to post a Harness Output comment confirming checks pass before the CTO marks a PR ready to merge. This is a process gate, not a GitHub branch protection rule (that can be added by the board at any time via GitHub repo settings).
4. **Review cadence** — scheduled as part of the CTO's weekly heartbeat.

Recommended future hardening (board action required):
- Enable GitHub branch protection on `master`: require PR, require status checks (typecheck + tests), require 1 approval.
- Add a `commit-msg` git hook that rejects commits without `(ANGA-N)` in the subject.
