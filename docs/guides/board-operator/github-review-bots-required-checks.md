---
title: Gate Merges on 5/5 Paperclip Reviews With GitHub Rulesets
summary: Turn structured 1–5 Paperclip agent assessments into a commit-bound Paperclip Review required check on main using opt-in GitHub Branch Rulesets.
---

A Paperclip review bot can score a pull request `3/5` and still let anyone click **Merge**—by design. Installing a GitHub Review Bot never modifies your GitHub branch protection or rulesets, because granting repository access, choosing review triggers, and blocking merges are three separate decisions. When you are ready to enforce review quality on `main`, add the **Paperclip Review** check to a GitHub Branch Ruleset so GitHub waits for a validated passing score on the exact commit being merged.

This tutorial covers four steps: why reviews stay advisory by default, how Paperclip validates structured `1–5` assessments into commit-bound checks, how to require **Paperclip Review** in GitHub Rulesets, and how repeat pushes and formal GitHub approvals interact with that gate.

## Prerequisites

- A connected GitHub Review Bot (enable **GitHub review bots** in instance **Experimental** settings and complete [GitHub Review Bots](/guides/board-operator/github-review-bots) first).
- At least one completed review on the repository so GitHub recognizes the **Paperclip Review** check name.
- GitHub repository admin permissions to edit **Settings → Rules → Rulesets**.

## 1. Keep three operator choices independent

Paperclip separates repository access, agent triggers, and merge enforcement so you can evaluate review quality safely before gating a team:

1. **Install the GitHub App** (GitHub + Paperclip **Access → Repositories**) — lets the bot read code, post comments, and publish checks.
2. **Choose triggers** (Paperclip **Settings → When to run**) — decides whether reviews run on `@app-slug` mentions only, automatically on PR events (`opened`, `synchronize`, `reopened`, `ready_for_review`), or both.
3. **Require `Paperclip Review`** (GitHub **Rulesets**) — tells GitHub that merging into `main` must wait for a green check on the current commit.

| Trigger in Paperclip | GitHub requires `Paperclip Review`? | Merge behavior |
| --- | --- | --- |
| Mentions only | No (default) | Advisory feedback on `@app-slug`. A `3/5` check does not block merging. |
| Automatic | No (default) | Automatic feedback on PR events. A `3/5` check does not block merging. |
| Mentions only | Yes (opt-in) | Merging waits until an authorized person `@mentions` the bot and the check passes. |
| Automatic | Yes (opt-in) | Reviews run automatically on opens/pushes and merging waits for a passing check. |

## 2. How Paperclip validates a `3/5` or `5/5` into a GitHub check

GitHub has no built-in concept of a `3/5` comment blocking a merge. Paperclip enforces the threshold server-side instead of letting the model declare its own pass:

1. The agent calls `begin_review` to receive the repository's active finding categories policy snapshot, inspects the diff through task-bound tools, and calls `submit_review` with `reviewedCommit`, `score` (`0`–`5`), `complete`, `summary`, `rationale`, `coverage`, and structured `findings`.
2. Paperclip validates the schema, rejects unknown finding categories, confirms coverage is complete, and compares `score` against your **Passing score** setting (**Settings → Review results**, defaults to `5` out of `5`, configurable `1`–`5`, or **Report only**).
3. Paperclip publishes a commit-bound GitHub check run named **Paperclip Review**:

| Review state | `Paperclip Review` check state | Blocks merge when required? |
| --- | --- | --- |
| Waiting for agent / actively running | `Queued` / `In progress` | Yes (pending) |
| Complete assessment meets passing score (e.g., `5/5`) | `Success` | No (passing) |
| Complete assessment falls below passing score (e.g., `3/5`) | `Failure` | Yes |
| Incomplete assessment, execution error, or manual review required (with a passing score configured) | `Action required` | Yes |
| Any completed check in **Report only** mode (including incomplete assessments or errors) | `Neutral` | No (advisory) |

Because incomplete assessments and tool failures cannot pass when a passing score is configured, a partial read never turns a required check green.

## 3. Add `Paperclip Review` to a GitHub Branch Ruleset

Configure merge enforcement explicitly inside GitHub (Paperclip never changes repository rules on your behalf):

1. In your GitHub repository, open **Settings → Rules → Rulesets** (or classic branch protection if your plan uses it).
2. Click **New ruleset → New branch ruleset** (or edit your existing `main` ruleset).
3. Under **Target branches**, add your default branch (for example, `main`).
4. Enable **Require status checks to pass** and click **Add checks**.
5. Search for and add **`Paperclip Review`**.
6. **Pin the expected source:** Where GitHub shows a source picker next to the check name, select your bot's dedicated GitHub App so another integration cannot satisfy the check (this is also how you require a specific bot when running multiple Paperclip review bots on one repo).
7. Set **Enforcement status** to **Active**, configure any admin bypass rules intentionally, and click **Create** / **Save changes**.

In Paperclip **Settings → When to run**, verify **New pull request** and **Updated commits** are enabled so new pushes automatically trigger a fresh check without waiting for a manual `@mention`.

## 4. What happens when a PR gets `3/5` and you push a fix

1. **Blocked at `3/5`:** The bot finds a real defect, posts inline findings and a `3/5` summary, and Paperclip publishes a red `Failure` check on commit `A`. GitHub blocks the **Merge pull request** button.
2. **Push fix commit `B`:** Every check is strictly bound to its commit SHA—an older passing result never carries forward, and stale runs cannot overwrite newer heads. Pushing commit `B` wakes the same Paperclip task automatically (when **Updated commits** is enabled) or on `@app-slug`.
3. **Validated `5/5` unlocks merge:** The bot reviews commit `B`, submits a complete `5/5` assessment, updates its single main PR comment in place, and Paperclip flips `Paperclip Review` to green `Success` on commit `B`. GitHub unlocks the merge button.
4. **If automatic runs are filtered out on a gated branch:** Paperclip publishes an `Action required` check prompting an authorized linked member or sponsored external contributor to trigger the review with `@app-slug`.

## Keep formal GitHub approvals separate

A `5/5` score and a green **Paperclip Review** check do **not** submit a formal GitHub **Approve** review. Under **Settings → Approvals and change requests**, both **Allow approvals** and **Allow request changes** are **off by default**. Leaving them off lets Paperclip enforce automated quality checks while keeping formal GitHub PR approvals reserved for human teammates.
