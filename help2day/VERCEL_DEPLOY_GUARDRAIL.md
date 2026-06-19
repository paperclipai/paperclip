# Vercel Deploy Guardrail

**Source issue:** [FUL-11094](/FUL/issues/FUL-11094)
**Script:** `scripts/vercel-deploy-check.sh`

Every Vercel preview or production push must pass preflight before pushing and postflight after. Both blocks on failure.

---

## Preflight — run before `git push`

```bash
./scripts/vercel-deploy-check.sh preflight <owner/repo> <branch> <vercel-project>
# Example:
./scripts/vercel-deploy-check.sh preflight paperclipai/paperclip main help2day-web
```

### What it verifies

| # | Check | How |
|---|-------|-----|
| 1 | Target repo and branch | `git remote get-url origin`, `git rev-parse --abbrev-ref HEAD` |
| 2 | Git remote owner/repo matches expected | String comparison vs `<owner/repo>` arg |
| 3 | GitHub actor (authenticated account) | `gh api /user` — name only, no token printed |
| 4 | Commit author email is verified on that GitHub account | `gh api /user/emails` — checks verified flag |
| 5 | Vercel project/org target is accessible | `GET /v9/projects/<name>` — project name only, no secrets printed |
| 6 | No secrets emitted | Script asserts this; exits non-zero on any failure |

### Account mismatch — unblock path

When the commit author email is not verified on the authenticated GitHub account:

- **Unblock owner:** the GitHub account holder (the person who owns the `gh_actor` account).
- **Self-serve fix A:** add and verify the email at `https://github.com/settings/emails`.
- **Self-serve fix B:** `git config user.email <an-already-verified-email-on-that-account>`.
- **When Grant is required:** only if the fix requires changes to Vercel org ownership or a GitHub org-level setting. Email association is self-serve.

---

## Postflight — run after `git push`

Run **before marking any issue complete** after a push.

```bash
SHA=$(git rev-parse HEAD)
./scripts/vercel-deploy-check.sh postflight "$SHA" <owner/repo> <branch> <vercel-project> [paperclip-issue-id]
# Example:
SHA=$(git rev-parse HEAD)
./scripts/vercel-deploy-check.sh postflight "$SHA" paperclipai/paperclip main help2day-web "$PAPERCLIP_TASK_ID"
```

### What it verifies

| # | Check | How |
|---|-------|-----|
| 1 | Push reached remote branch | `git ls-remote origin refs/heads/<branch>` |
| 2 | GitHub commit/check status exists for SHA | `gh api /repos/<owner/repo>/commits/<sha>/check-runs` |
| 3 | Vercel deployment created for SHA | Poll `GET /v6/deployments?projectId=<id>`, match on `meta.githubCommitSha` |
| 4 | Vercel deployment reaches `READY` | Polls every 15s up to `VERCEL_POLL_TIMEOUT_SECONDS` (default 300s) |
| 5 | Structured issue comment | Posts table to Paperclip issue if `PAPERCLIP_API_URL/KEY` are set |

### Postflight comment fields

The postflight summary includes:

- Branch and SHA
- GitHub actor (pusher) and commit author login
- Vercel project name and deployment ID
- Deployment state
- Preview URL and whether it is safe to share publicly
- GitHub check run count and summary
- UTC timestamp

### Failure and escalation table

| Failure | Blocker owner | Unblock action |
|---------|--------------|----------------|
| Remote SHA mismatch | Pushing agent | Retry push; check network/auth |
| Commit not on GitHub | Pushing agent | Verify push with `git ls-remote` |
| No Vercel deployment after 5min | DevOps/Infrastructure Lead | Verify Vercel webhook configured for repo and branch |
| Deployment `ERROR` or `CANCELED` | DevOps/Infrastructure Lead | Inspect Vercel deployment logs at https://vercel.com/dashboard |
| Deployment stuck `BUILDING` | DevOps/Infrastructure Lead | Check Vercel build logs; extend `VERCEL_POLL_TIMEOUT_SECONDS` if builds are slow |

---

## Required env vars

| Var | Purpose | Required for |
|-----|---------|-------------|
| `GH_TOKEN` or `GITHUB_TOKEN` | GitHub auth — consumed by `gh` CLI; never in argv | preflight + postflight |
| `VERCEL_TOKEN` | Vercel API auth — passed via `curl --config`, never in argv | preflight + postflight |
| `PAPERCLIP_API_URL` | Paperclip API base | postflight comment (optional) |
| `PAPERCLIP_API_KEY` | Paperclip API auth — passed via `curl --config` | postflight comment (optional) |
| `PAPERCLIP_RUN_ID` | Paperclip run tracing header | postflight comment (optional) |
| `VERCEL_POLL_TIMEOUT_SECONDS` | Override default 300s poll timeout | postflight (optional) |

---

## Security properties

- Script never echoes `VERCEL_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, or `PAPERCLIP_API_KEY` values.
- Vercel API calls use `curl --config <(printf ...)` — token is not in process argv (SH-10 compliant).
- Paperclip API calls use a temp file (chmod 600) for the auth header — not in process argv (SH-10 compliant).
- GitHub API calls use `gh api` — token handled internally by the gh CLI.
- Do **not** use `vercel curl` in deploy scripts (SH-8); this script uses plain `curl`.
- Do **not** pass tokens as CLI arguments to any command.
- This script does **not** mutate Vercel project settings.

---

## Checklist for deploy tickets

Add to the issue description or deploy ticket:

```markdown
### Deploy checklist

- [ ] `./scripts/vercel-deploy-check.sh preflight <owner/repo> <branch> <project>` — PASSED
- [ ] `git push origin <branch>`
- [ ] `./scripts/vercel-deploy-check.sh postflight <sha> <owner/repo> <branch> <project> <issue-id>` — PASSED (see postflight comment)
```

---

## Related policies

- Secret handling: `/help2day/SECRET_HANDLING_POLICY.md`
- SH-8 (no `vercel curl`): [FUL-3128](/FUL/issues/FUL-3128)
- SH-10 (no secrets in argv): [FUL-4346](/FUL/issues/FUL-4346)
- Routing governor: `/help2day/ROUTING_GOVERNOR.md`
