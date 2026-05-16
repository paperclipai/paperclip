# Supabase Edge Function Deployment Policy

**Version:** 1.0
**Status:** Draft
**Owner:** Hunter (CTO)
**Applies to:** All Supabase Edge Functions deployed for Paperclip projects

## Purpose

Define a repeatable, auditable, and secure deployment path for Supabase Edge Functions. Every deployment must be credential-safe, logged, and verifiable by QA before it is marked complete.

## Scope

This policy covers all Supabase Edge Functions maintained under the `supabase/functions/` directory. Currently deployed functions:

| Function | Purpose | Supabase Project |
|----------|---------|-----------------|
| `chase-telegram` | Telegram-to-Paperclip bridge bot | `tujyntcurpxvxgokcsaz` (AvvA App V2.0) |

---

## 1. Credential Management

### Where Deploy Credentials Live

All Supabase deployment credentials are stored as **GitHub Actions encrypted secrets** at the repository level. The following secrets are required:

| Secret Name | Purpose | Source |
|-------------|---------|--------|
| `SUPABASE_ACCESS_TOKEN` | Supabase CLI authentication (personal access token with `functions:write` scope) | Supabase dashboard → Account → Access Tokens |
| `SUPABASE_PROJECT_REF` | Supabase project reference ID (e.g., `tujyntcurpxvxgokcsaz`) | Supabase project settings |

### Edge Function Runtime Secrets

Runtime environment variables for each function are stored as **Supabase secrets** (managed via `supabase secrets set`) and are separate from deploy credentials. These are set during initial deployment and updated during secret rotation.

For the `chase-telegram` function, the required runtime secrets are:

| Secret | Required | Description |
|--------|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Yes | Bot token for Telegram Bot API |
| `PAPERCLIP_API_URL` | Yes | Paperclip API base URL |
| `CHASE_PAPERCLIP_API_KEY` | Yes | Chase's Paperclip API key |
| `PAPERCLIP_COMPANY_ID` | Yes | Company UUID for API queries |
| `CHASE_AGENT_ID` | Yes | Chase — Dispatcher agent ID for Paperclip agent wakeup |
| `ALLOWED_TELEGRAM_USER_IDS` | No | Comma-separated Telegram user IDs (empty = open) |
| `WEBHOOK_SETUP_SECRET` | No | Secret for `/setup-webhook` auth |
| `DEEPSEEK_API_KEY` | No | DeepSeek API key (primary AI provider) |
| `ANTHROPIC_API_KEY` | No | Anthropic API key (fallback AI provider) |

### Who Can Access

- **GitHub Secrets**: Only repository administrators and the CI/CD pipeline (GitHub Actions) have access. Secrets are never exposed in plaintext in logs or outputs.
- **Supabase Secrets**: Set via the Supabase CLI during deployment. The CLI authenticates through `SUPABASE_ACCESS_TOKEN`. Individual secret values are never committed to the repository.
- **Agents**: Agents never hold deploy credentials. They trigger deployments through workflow dispatch or PR merge, and the CI/CD pipeline resolves credentials from GitHub encrypted secrets.

---

## 2. Deployment Request Workflow

Two paths are available for deploying Supabase Edge Functions:

### Path A: Workflow Dispatch (Manual Trigger)

For ad-hoc or emergency deployments, use `workflow_dispatch` on the GitHub Actions workflow.

1. Navigate to the repository's Actions tab
2. Select the "Deploy Supabase Edge Functions" workflow
3. Click "Run workflow"
4. Select the target function(s) to deploy
5. Select the environment (staging / production) — currently only production exists
6. Click "Run workflow"

The workflow:
- Checks out the specified git ref
- Installs Supabase CLI
- Authenticates with `SUPABASE_ACCESS_TOKEN`
- Links the project with `SUPABASE_PROJECT_REF`
- Deploys the selected function(s)
- Logs the outcome

### Path B: Automated on PR Merge (CI/CD)

For routine deployments, the workflow triggers automatically when a PR that modifies files under `supabase/functions/` is merged to the default branch.

The auto-trigger:
- Detects changed function directories
- Deploys only the changed functions
- Posts a deployment summary as a comment on the merge commit

### Before Deploying

The deployer must confirm:

1. The function code has been reviewed (code review or QA code review)
2. Tests pass (run `deno test` in the function directory)
3. The working tree is clean (no uncommitted changes)
4. Any new environment variables have been documented in the function's `.example.env` and `README.md`

---

## 3. Deployment Steps

The actual deployment is performed by the CI/CD pipeline. The manual equivalent is documented here for reference:

```bash
# 1. Install Supabase CLI (pipeline-managed)
# 2. Link project
supabase link --project-ref <ref>

# 3. Deploy function(s)
supabase functions deploy <function-name> --no-verify-jwt

# 4. Set or update runtime secrets (as needed)
supabase secrets set TELEGRAM_BOT_TOKEN=<token>
supabase secrets set PAPERCLIP_API_URL=<url>
# ... additional secrets as required

# 5. Verify deployment
#    Function URL: https://<ref>.functions.supabase.co/<function-name>
```

Functions are deployed with `--no-verify-jwt` because authentication is handled internally (webhook signature verification, bearer token checks) rather than through Supabase's JWT verification.

---

## 4. Deployment Logging

Every deployment is logged in two places:

### GitHub Actions Run Logs

The CI/CD workflow produces a run log that captures:

- Which function was deployed
- Which git SHA was deployed
- Whether the deployment succeeded or failed
- Duration of the deployment
- Any warnings or errors from Supabase CLI

These logs are retained per GitHub's retention policy (default: 90 days for public repos, configurable for private).

### Post-Deploy Issue Comment

When a deployment is triggered by an issue (via workflow dispatch), the deploying agent MUST post a comment on the triggering issue with:

```
Deployed: <function-name> to Supabase production
SHA: <commit-sha>
Status: success / failed
Function URL: https://<ref>.functions.supabase.co/<function-name>
Runtime secrets: <list of which secrets were set/updated>
QA verification: pending / waived (reason)
```

---

## 5. Secrets Rotation

### Schedule

Runtime secrets should be rotated:

- **On demand**: When a secret is compromised or exposed
- **Periodically**: At least every 90 days for API keys and tokens
- **On departure**: When a team member with knowledge of secrets leaves

### Rotation Procedure

1. Generate new secret value outside the repository (e.g., new API key from provider dashboard)
2. Update the GitHub encrypted secret if the deploy credential itself is being rotated
3. Run the deployment workflow with the `secrets-only` mode to update Supabase secrets without deploying function code
4. Verify the function still operates correctly with the new secrets
5. Revoke the old secret value after confirmation

### Rotation Logging

Secret rotations are logged in the issue that triggers them, including which secrets were rotated and the outcome. The actual secret values are never written to logs.

---

## 6. QA Verification Process

### Before QA

After deployment, the deploying agent MUST:

1. Verify the function responds to health checks:
   ```bash
   curl -f https://<ref>.functions.supabase.co/<function-name>/health
   ```
2. Verify the function is running the expected version (if version endpoint exists)
3. Run any existing integration tests against the live function

### QA Gate (Quinn)

All production deployments of Supabase Edge Functions require Quinn (QA Director) to review and verify the live deployment before the deployment issue can be marked done.

Quinn's verification must include:

1. **Code review**: Inspect the deployed code for correctness and safety
2. **Live health check**: Confirm the function responds to HTTP requests
3. **Live behavior test**: For user-facing functions (e.g., `chase-telegram`), test the expected behavior against the live endpoint
4. **Secrets audit**: Confirm no secrets were exposed in logs or comments
5. **Repo state**: Confirm the working tree is clean and no artifacts were committed

Quinn documents the outcome with one of:

| Classification | Meaning |
|----------------|---------|
| **QA: Live production verified** | Tested against live production endpoint, behavior confirmed correct |
| **QA: Automated tests only** | Tests pass against deployed function, no manual live test performed |
| **QA: Code review only** | Code inspected only, no live verification |
| **QA: Blocked** | Deployment has issues that must be resolved before marking done |

### Exception

The CEO or CTO may waive live QA verification for emergency hotfixes or non-user-facing changes. The waiver must be documented in the deployment issue thread.

---

## 7. Blocked Deployment Protocol

If a deployment is blocked, the deploying agent MUST:

1. **Identify the blocker** — determine whether the block is:
   - **Missing credential**: `SUPABASE_ACCESS_TOKEN` expired, missing, or insufficient scope
   - **Supabase project issue**: Project unreachable, quota exceeded, maintenance mode
   - **Code issue**: Function code fails to deploy (syntax error, denied permissions, missing import)
   - **Secret rotation needed**: Runtime secrets are missing or expired
2. **Mark the issue blocked** — set status to `blocked` and add a comment specifying:
   - The exact blocker (e.g., "`SUPABASE_ACCESS_TOKEN` expired — requires renewal in GitHub secrets")
   - Who can unblock (named person or role)
   - What the agent will do once unblocked
3. **Set a blocker issue** — if the blocker requires its own work item, create a child issue with `blockedByIssueIds` linking them

### Example Blocker Comment

```
Blocked: SUPABASE_ACCESS_TOKEN has expired.
Required to authenticate supabase CLI for deploying chase-telegram.
Action needed: Repository admin to generate a new Supabase access token
at https://supabase.com/dashboard/account/tokens and update the
SUPABASE_ACCESS_TOKEN GitHub secret.
Once provided: I will re-run the deployment workflow and verify.
```

---

## 8. Related Documents

- [Deployment Completion Policy](/docs/deployment-completion-policy.md) — Overall completion gate for all production deployments
- [Quinn QA Gate](/docs/knowledge-base/quinn-qa-gate.md) — QA review scope and mechanism
- [Secrets Management](/docs/deploy/secrets.md) — Paperclip secrets storage and resolution
- [Deployment Modes](/docs/deploy/deployment-modes.md) — Paperclip server deployment modes
- [Environment Variables](/docs/deploy/environment-variables.md) — Runtime environment variable reference

---

## Appendices

### A. GitHub Workflow Template

The following workflow file should be created at `.github/workflows/deploy-supabase-functions.yml`:

```yaml
name: Deploy Supabase Edge Functions

on:
  workflow_dispatch:
    inputs:
      functions:
        description: 'Functions to deploy (comma-separated, or "all")'
        required: true
        default: 'all'
  push:
    branches: [main]
    paths:
      - 'supabase/functions/**'

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: supabase/setup-cli@v1
        with:
          version: latest

      - name: Link Supabase project
        run: supabase link --project-ref ${{ secrets.SUPABASE_PROJECT_REF }}
        env:
          SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}

      - name: Deploy functions
        run: |
          if [ "${{ github.event_name }}" = "push" ]; then
            CHANGED=$(git diff --name-only ${{ github.event.before }}...${{ github.sha }} | grep '^supabase/functions/' | cut -d/ -f3 | sort -u)
            for func in $CHANGED; do
              supabase functions deploy "$func" --no-verify-jwt
            done
          else
            if [ "${{ github.event.inputs.functions }}" = "all" ]; then
              for func in supabase/functions/*/; do
                supabase functions deploy "$(basename $func)" --no-verify-jwt
              done
            else
              IFS=',' read -ra ADDR <<< "${{ github.event.inputs.functions }}"
              for func in "${ADDR[@]}"; do
                supabase functions deploy "$func" --no-verify-jwt
              done
            fi
          fi
        env:
          SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}

      - name: Post deployment summary
        run: |
          echo "## Supabase Edge Function Deployment" >> $GITHUB_STEP_SUMMARY
          echo "Deployed to project: \`${{ secrets.SUPABASE_PROJECT_REF }}\`" >> $GITHUB_STEP_SUMMARY
          echo "SHA: \`${{ github.sha }}\`" >> $GITHUB_STEP_SUMMARY
          echo "Status: ✅ success" >> $GITHUB_STEP_SUMMARY
```

### B. Function Health Check

All production Supabase Edge Functions MUST expose a health check endpoint at `GET /health` (or `GET /`) that returns HTTP 200 when the function is operational. The health endpoint must not require authentication so that automated monitoring can reach it.

### C. Post-Deployment Verification Checklist

- [ ] Health check returns 200
- [ ] Runtime secrets are set (call `supabase secrets list` to verify)
- [ ] Function responds correctly to test inputs
- [ ] Tests pass against the live function (if integration tests exist)
- [ ] Webhook is configured (for webhook-driven functions like `chase-telegram`)
- [ ] Deployment comment is posted on the triggering issue
- [ ] Quinn QA review is requested via execution policy
