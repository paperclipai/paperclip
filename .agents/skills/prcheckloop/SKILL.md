---
name: prcheckloop
description: >
  Iteratively gets a GitHub pull request's checks green. Detects the PR for the
  current branch or uses a provided PR number, waits for every check on the
  latest head SHA to appear and finish, investigates failing checks, fixes
  actionable code or test issues, pushes, and repeats. Escalates with a precise
  blocker when failures are external, flaky, or not safely fixable. Use when a
  PR still has unsuccessful checks after review fixes, including after greploop.
---

# PRCheckloop

Get a GitHub PR to a fully green check state, or exit with a concrete blocker.

## Scope

- GitHub PRs only. If the repo is GitLab, stop and use `check-pr`.
- Focus on checks for the latest PR head SHA, not old commits.
- Focus on CI/status checks, not review comments or PR template cleanup.
- If the user also wants review-comment cleanup, pair this with `check-pr`.

## Inputs

- **PR number** (optional): If not provided, detect the PR for the current branch.
- **Max iterations**: default `5`.

## Workflow

### 1. Identify the PR

If no PR number is provided, detect it from the current branch:

```bash
gh pr view --json number,headRefName,headRefOid,url,isDraft
```

If needed, switch to the PR branch before making changes.

Stop early if:

- `gh` is not authenticated
- there is no PR for the branch
- the repo is not hosted on GitHub

### 2. Track the latest head SHA

Always work against the current PR head SHA:

```bash
PR_JSON=$(gh pr view "$PR_NUMBER" --json number,headRefName,headRefOid,url)
HEAD_SHA=$(echo "$PR_JSON" | jq -r .headRefOid)
PR_URL=$(echo "$PR_JSON" | jq -r .url)
```

Ignore failing checks from older SHAs. After every push, refresh `HEAD_SHA` and
restart the inspection loop.

### 3. Inventory checks for that SHA

Fetch both GitHub check runs and legacy commit status contexts:

```bash
gh api "repos/{owner}/{repo}/commits/$HEAD_SHA/check-runs?per_page=100"
gh api "repos/{owner}/{repo}/commits/$HEAD_SHA/status"
```

For a compact PR-level view, this GraphQL payload is useful:

```bash
gh api graphql -f query='
query($owner:String!, $repo:String!, $pr:Int!) {
  repository(owner:$owner, name:$repo) {
    pullRequest(number:$pr) {
      headRefOid
      url
      statusCheckRollup {
        contexts(first:100) {
          nodes {
            __typename
            ... on CheckRun { name status conclusion detailsUrl workflowName }
            ... on StatusContext { context state targetUrl description }
          }
        }
      }
    }
  }
}' -F owner=OWNER -F repo=REPO -F pr="$PR_NUMBER"
```

### 4. Wait for checks to actually run

After a new push, checks can take a moment to appear. Poll every 15-30 seconds
until one of these is true:

- checks have appeared and every item is in a terminal state
- checks have appeared and at least one failed
- no checks appear after a reasonable wait, usually 2 minutes

Treat these as terminal success states:

- check runs: `SUCCESS`, `NEUTRAL`, `SKIPPED`
- status contexts: `SUCCESS`

Treat these as pending:

- check runs: `QUEUED`, `PENDING`, `WAITING`, `REQUESTED`, `IN_PROGRESS`
- status contexts: `PENDING`

Treat these as failures:

- check runs: `FAILURE`, `TIMED_OUT`, `CANCELLED`, `ACTION_REQUIRED`, `STARTUP_FAILURE`, `STALE`
- status contexts: `FAILURE`, `ERROR`

If no checks appear for the latest SHA, inspect `.github/workflows/`, workflow
path filters, and branch protection expectations. If the missing check cannot be
caused or fixed from the repo, escalate.

### 5. Investigate failing checks

For GitHub Actions failures, inspect runs and failed logs for the current SHA:

```bash
gh run list --commit "$HEAD_SHA" --json databaseId,workflowName,status,conclusion,url,headSha
gh run view <RUN_ID> --json databaseId,name,workflowName,status,conclusion,jobs,url,headSha
gh run view <RUN_ID> --log-failed
```

For each failing check, classify it:

| Failure type | Action |
|---|---|
| Code/test regression | Reproduce locally, fix, and verify |
| Lint/type/build mismatch | Run the matching local command from the workflow and fix it |
| Flake or transient infra issue | Rerun once if evidence supports flakiness |
| External service/status app failure | Escalate with the details URL and owner guess |
| Missing secret/permission/branch protection issue | Escalate immediately |

Only rerun a failed job once without code changes. Do not loop on reruns.

### 6. Fix actionable failures

If the failure is actionable from the checked-out code:

1. Read the workflow or failing command to identify the real gate.
2. Reproduce locally where reasonable.
3. Make the smallest correct fix.
4. Run focused verification first, then broader verification if needed.
5. Commit in a logical commit.
6. Push before re-checking the PR.

Do not stop at a local fix. The loop is only complete when the remote PR checks
for the new head SHA are green.

### 7. Push and repeat

After each fix:

```bash
git push
sleep 5
```

Then refresh the PR metadata, get the new `HEAD_SHA`, and restart from Step 3.

Exit the loop only when:

- all checks for the latest head SHA are green, or
- a blocker remains after reasonable repair effort, or
- the max iteration count is reached

### 8. Escalate blockers precisely

If you cannot get the PR green, report:

- PR URL
- latest head SHA
- exact failing or missing check names
- details URLs
- what you already tried
- why it is blocked
- who should likely unblock it
- the next concrete action

Good blocker examples:

- external status app outage
- missing GitHub secret or permission
- required check name mismatch in branch protection
- persistent flake after one rerun
- failure needs credentials or infrastructure access you do not have

## Output

When the skill completes, report:

- PR URL and branch
- final head SHA
- green/pending/failing check summary
- fixes made and verification run
- whether changes were pushed
- blocker summary if not fully green

## Notes

- This skill is intentionally narrower than `check-pr`: it is a repair loop for
  PR checks.
- This skill complements `greploop`: Greptile can be perfect while CI is still
  red.
