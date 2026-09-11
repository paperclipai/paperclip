---
name: deploy
description: >
  Promote a merged PR to a company's deployment target via the unified
  mv50000/cicd pipeline: watch the deploy workflow, validate the running
  service, and document rollback. Use when leadership says "deploy to prod",
  "ship this to <company>", "promote PR <N>", or after `prcheckloop` and merge
  for a Dockerized company. Do NOT use for the Paperclip product itself
  (use `release` instead) or for non-Dockerized companies still pending
  migration to mv50000/cicd.
---

# Deploy Skill

Promote a merged change to a company's deploy host through the unified
mv50000/cicd pipeline. The skill assumes the PR is already merged and CI green;
this skill picks up from there.

## Scope

- Per-company deployment via mv50000/cicd reusable workflows.
- The skill runs locally on the engineer-agent's workstation.
- Only Dockerized companies (those whose repo has `Dockerfile` + `deploy/docker-compose.yml`).

Do NOT use this skill for:

- Paperclip product releases — use `release` (npm canary, GitHub Release).
- Getting a PR's checks green before merge — use `prcheckloop`.
- Companies that have not yet migrated to mv50000/cicd. For those, follow the
  company's existing CLAUDE.md until the migration ticket is closed.

## Preconditions

Before proceeding, verify all of the following:

1. `gh` is authenticated for the target repo (`gh auth status`).
2. The PR is merged (`gh pr view <N> --json mergedAt` returns a non-null timestamp).
3. The repo's `deploy.yml` workflow exists and references `mv50000/cicd@v1`.
4. `DEPLOY_SSH_KEY` secret is configured on the repo (`gh secret list --repo mv50000/<co>`).
5. The deploy host's `/srv/<co>/<env>/.env` exists and has company-specific vars filled.

If any precondition fails, stop and report the blocker.

## Inputs

Collect up front:

- **company** slug (e.g. `saatavilla`, `ololla`, `alli-audit`)
- **PR number** (optional — if not provided, detect from current branch)
- **environment** (`dev` | `prod`, default `prod`)
- **rollback?** (true if the goal is to roll back instead of forward-deploy)

## Workflow

### 1. Identify the merge

```bash
gh pr view <N> --json mergedAt,mergeCommit,baseRefName,number,url
```

- Require `mergedAt != null`. If null: stop, report "PR not merged".
- Capture `MERGE_SHA = mergeCommit.oid` for run lookup.

### 2. Watch the deploy workflow

```bash
RUN_ID=$(gh run list --commit "$MERGE_SHA" \
  --workflow deploy.yml \
  --limit 1 \
  --json databaseId,status,conclusion \
  --jq '.[0].databaseId')

gh run watch "$RUN_ID" --exit-status
```

If the workflow has not started yet, wait up to 60 s and retry. If it doesn't
exist after 5 min, the auto-trigger may be misconfigured — escalate.

### 3. Health-check post-deploy

The deploy workflow itself runs `wait-for-health` automatically; this is a
secondary external validation:

```bash
for i in 1 2 3; do
  curl -sSf "https://<company>.rk9.fi/api/health" && break
  sleep 5
done
```

### 4. Smoke test (company-specific)

Run the company's smoke check:

- `saatavilla`: 3 test orders end-to-end
- `alli-audit`: 1 audit URL queue-completed
- `quantimodo`: WS connection + 1 trade-cycle dry run
- `bk` / `ololla`: e2e suite green
- `optimi`: TBD when migrated

### 5. Document outcome

Report back:

- PR URL, MERGE_SHA, image-tag (`gh run view $RUN_ID --json jobs --jq '.jobs[0].steps[] | select(.name=="Build and push Docker image") | .conclusion'` and the `:sha-XXX` from logs)
- Workflow run URL
- Health-check status
- Any rollback action taken

### 6. Rollback (only if instructed)

Do NOT roll back automatically on health failure — the deploy workflow already
attempts auto-rollback. The skill's role is to **document** the failure and
**generate** the manual rollback command for human approval:

```bash
gh workflow run deploy.yml \
  --repo "mv50000/<company>" \
  -f action=rollback \
  -f environment="<env>"
```

Or directly on the deploy host:

```bash
ssh deploy@<host> "bash /srv/<company>/<env>/rollback.sh <company> <env>"
```

## Distinction from related skills

- **`release`** — Paperclip product npm canary/stable. Different scope entirely.
- **`prcheckloop`** — runs BEFORE merge to get checks green. `deploy` runs AFTER merge.
- **`pr-report`** — summarizes PR status, doesn't touch deployment.

## Failure modes

- **Workflow doesn't trigger**: check `.github/workflows/deploy.yml` references
  `mv50000/cicd/.github/workflows/build-and-deploy.yml@v1` and `on: push: branches: [main]` is correct.
- **GHCR push fails**: token scope insufficient or rate-limited; check workflow logs.
- **SSH connection refused**: `DEPLOY_SSH_KEY` rotated without updating secret.
  Run `bash <(curl -L https://raw.githubusercontent.com/mv50000/cicd/v1/scripts/server-bootstrap.sh) <co> <env>`
  to re-bootstrap.
- **Health check fails**: workflow auto-rolls back to previous-tag. Investigate
  the offending image (`docker run --rm ghcr.io/mv50000/<co>:<sha> ...`) before retrying.

## References

- Pipeline source: https://github.com/mv50000/cicd
- Onboarding: https://github.com/mv50000/cicd/blob/main/docs/onboarding.md
- Migration: https://github.com/mv50000/cicd/blob/main/docs/migration-from-systemd.md
