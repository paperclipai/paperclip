---
title: CEO runbook — triage for inbound GitHub CI issues
summary: How the CEO agent governs Paperclip issues auto-created from GitHub workflow and check-run failures (paperclip-github plugin).
audience: CEO role / board operators backing the CEO agent
---

## Purpose

The **paperclip-github** integration opens Paperclip issues when GitHub reports:

- **Workflow failures** — title pattern: `CI failure: <workflow> #<n> on <org/repo>`
- **PR check failures** — title pattern: `PR gate failure: <check> on <org/repo>`

Those events are **noisy**: the same underlying problem can spawn many tickets; some failures are **expected** (e.g. deploy drift while `master` is ahead of production); others need **secrets or workflow fixes** on GitHub. Without triage, backlog fills with duplicates and assignees get **invoke storms**.

This document defines a **repeatable triage system** the CEO owns at the policy level and can delegate execution to a **Senior Platform Engineer** for GitHub/API verification.

**Related:** [GitHub workflow & release policy](./github-workflow-policy.md), [`doc/RELEASING.md`](../../doc/RELEASING.md), plugin worker in `packages/plugins/github-integration/src/worker.ts`.

---

## Goals

1. **Every inbound CI issue** gets a clear disposition within a short SLA (see cadence).
2. **False positives and stale gates** are closed with a **dated triage comment** and correct terminal status (`done` or `cancelled`), not left in `backlog` forever.
3. **Real incidents** become a single **owned** task (`todo` / `in_progress`) with **one** assignee and no duplicate plugin tickets for the same root cause.
4. **Roles stay separated**: CEO sets policy and approves bulk closures; **Platform Engineer** performs merge, deploy, workflow triggers, and GitHub verification when needed.

---

## Cad SLA (suggested)

| Volume | CEO/board action |
|--------|-------------------|
| **Daily** (5 min) | Scan new high-priority / backlog items whose titles match CI or PR gate patterns; apply quick disposition for obvious stale or duplicate items. |
| **Weekly** (15–30 min) | Full sweep: merge duplicate threads, close obsolete gates, ensure no assignee is overloaded with duplicate invokes. |
| **Per incident** | For `critical`/`high` failures on default branch, disposition within **same business day** after Platform confirms GitHub state. |

Adjust cadence if the org has heavy CI churn; the invariant is **no unbounded accumulation** of plugin-created backlog.

---

## Classification rubric

Use the **check or workflow name** and **GitHub reality** (not the issue age alone).

### A — Expected / policy, not a bug

| Signal | Examples | Disposition |
|--------|-----------|-------------|
| Production intentionally behind `master` | **Deploy Drift Check**, **drift-check** gate | **Close** with comment: `master` SHA vs `current-image` on host (see deploy runbook). If they match after deploy, ticket is obsolete. If they differ **on purpose**, close and point to release/deploy schedule. |
| Stable release prerequisites | **publish_stable**, Release workflow “missing `releases/v*.md`” | **Close** or **cancel** plugin ticket; real work is “add release notes + run Release” per [`doc/RELEASING.md`](../../doc/RELEASING.md), not a mystery auth failure. |
| Nightly canary succeeded after a red run | **publish_canary** | **Close** stale failure if **current** canary publish and `npm whoami` are green (`npm-canary` env + `NPM_TOKEN`). |

### B — Configuration (GitHub or npm)

| Signal | Disposition |
|--------|-------------|
| `NPM_TOKEN` / `ENEEDAUTH` **and** recent runs still red | **Keep open** → `todo`, assign Platform; verify **GitHub Environments** `npm-canary` / `npm-stable` secrets (Automation token). |
| Branch protection API **403** on audit | **Verify** [Branch Protection Audit](https://github.com/Viraforge/paperclip/actions/workflows/branch-protection-audit.yml) with admin PAT workflow; close stale tickets after green manual run. |

### C — Real regression

| Signal | Disposition |
|--------|-------------|
| **verify** / **policy** / tests fail on **multiple** PRs at same commit class | **One** parent issue `in_progress`, link runs; **cancel** duplicate plugin children. |
| **Deploy Vultr** red with image/build failure | Treat as **incident**; Platform owns investigation; CEO ensures single thread. |

### D — Not CI at all

Some backlog items are **human-authored** (e.g. `fix(server): …` in title). **Do not** bulk-close with CI triage; leave in backlog or promote to `todo` as normal product work.

---

## Standard operating procedure (per issue)

1. **Open the GitHub run or check URL** embedded in the issue body (plugin includes links).
2. **Classify** using the rubric above (A/B/C/D).
3. **Verify current state** (Platform Engineer or CEO with API access):
   - Default branch vs production image tag (drift).
   - Latest workflow runs for that workflow name (`success` vs `failure`).
   - For npm: distinguish **canary** vs **stable** and auth vs **missing changelog file**.
4. **Post a Paperclip comment** — always include:
   - Date and **triage** label in prose (e.g. “Triage 2026-03-19:”).
   - **Evidence**: SHAs, run IDs, or “matches / does not match”.
   - **Next owner** if still open (usually Platform or a named dev agent).
5. **Set status**:
   - **done** — incident resolved or ticket obsolete; set completed timestamp when your control plane supports it.
   - **cancelled** — duplicate or invalid alert.
   - **todo** / **in_progress** — real work remains; **dedupe** other plugin tickets for the same root cause.

---

## Deduping and invoke hygiene

- **One root cause → one open issue.** Search by workflow/check name and date range; cancel extras with a comment linking the **canonical** issue ID.
- If the plugin **invoked** an assignee on every failure, consider **reassigning** follow-up to Platform only after dedupe to avoid heartbeat noise.
- Prefer **commenting on an existing in-progress** issue when the plugin would have linked a PR; the worker tries to attach failures to linked issues when PR context exists — when that works, **no new backlog item** is created (`commentOnLinkedIssues` path in `worker.ts`).

---

## Delegation (CEO → Platform)

Use a **single delegated task** rather than many parallel “fix CI” comments:

- **Request:** Verify GitHub Actions state for run &lt;url&gt;, confirm drift/npm/branch-protection, reply with SHAs and conclusions.
- **Hard stop:** Platform does **not** use production shell edits for app deploy; fixes land via **PR + merge + workflow** per `AGENTS.md`.

---

## Optional improvements (engineering backlog)

These reduce inbound noise; they are **not** required to start triage:

- Plugin: create issues in **`backlog`** with **`medium`** priority for non-default-branch failures (requires product decision + code change).
- Plugin: cooldown or **dedupe key** `{repo, workflow, conclusion}` per 24h window.
- Board: **label** `source:github-plugin` for filtered views.

---

## Quick verification commands (for delegates)

Use from a trusted machine with `gh` and (if allowed) read-only production checks:

```bash
# Default branch SHA
git ls-remote https://github.com/Viraforge/paperclip.git refs/heads/master

# Recent runs for a workflow
gh run list --repo Viraforge/paperclip --workflow=deploy-drift-check.yml --limit 5
gh run list --repo Viraforge/paperclip --workflow=release.yml --limit 5
```

VPS image pointer (operator path): see [github-workflow-policy.md](./github-workflow-policy.md) and internal deploy docs for `current-image`.

---

## Related docs

- [`docs/deploy/github-workflow-policy.md`](./github-workflow-policy.md) — three lanes (merge / deploy / npm)
- [`doc/RELEASING.md`](../../doc/RELEASING.md) — stable vs canary, release notes path
- [`AGENTS.md`](../../AGENTS.md) — production GitHub-only policy, role separation
