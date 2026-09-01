# Runner E2E security for a public repository

This suite can spend provider money, expose four API credentials to isolated
test processes, publish a container, and write public evidence. Treat changes
to the workflow, harness, fixture prompts, evidence packager, and publisher as
security-sensitive production changes.

## GitHub authorization

Set `RUNNER_E2E_ALLOWED_ACTOR_IDS` to a non-empty JSON array of numeric GitHub
user IDs, for example `[123456,789012]`. Resolve each ID from the authenticated
CLI and verify the login before adding it:

```bash
gh api users/LOGIN --jq '{login,id}'
```

The workflow rejects manual dispatches outside the default branch before
checkout. It verifies both the original actor and triggering actor for manual
runs, and the triggering actor for human reruns of scheduled runs. Numeric IDs
are stable across username changes and prevent lookalike-name authorization.

Protect the default branch, require review for workflow/harness paths, restrict
workflow dispatch permission, and restrict repository variable/environment
administration to the same trusted maintainers. Configure the organization to
allow only approved GitHub Actions. A malicious change merged into the default
branch executes with the same authority as the suite.

Every external action in the paid workflow is pinned to a full commit SHA. Keep
the adjacent major-version comment for update tooling, and resolve and review a
new immutable SHA before upgrading an action. The credential-free security test
rejects mutable tag or branch references.

## Secrets and protected environments

Create `runner-e2e-paid`, restrict deployments to the default branch, and put
only `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, and
`DAYTONA_API_KEY` in it. The authorize, catalog, image, report, history, and
Pages jobs receive none of these secrets. The Paperclip server process also
receives none; the browser posts each value once to the encrypted company
secret API and agents/environments retain only secret references.

Create `runner-e2e-history`, also default-branch-only, for the OIDC publishing
job. It contains no long-lived AWS key. Required reviewers may be added when a
human approval on every nightly publication is acceptable; otherwise rely on
the actor gate, environment branch restriction, and protected default branch.

## Runner group isolation

Restrict the `ubuntu-latest-m` runner group to `paperclipai/paperclip` and, when
the GitHub plan supports selected-workflow restrictions, to
`.github/workflows/runner-full-stack-e2e.yml` on the default branch. Never let
fork or pull-request workflows target the group. Use ephemeral runners, or
guaranteed reimaging between jobs, and do not share this group with untrusted
workloads. Disable interactive SSH/debug access for paid jobs unless a separate
incident procedure explicitly authorizes it.

## AWS OIDC and S3

The AWS role trust policy should accept only GitHub's OIDC audience and the
publishing environment subject:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": "repo:paperclipai/paperclip:environment:runner-e2e-history"
        }
      }
    }
  ]
}
```

Grant only List on the bucket prefix and Get/Put on its objects. Do not grant
Delete, ACL, bucket-policy, or wildcard-resource permissions:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::BUCKET",
      "Condition": {
        "StringLike": { "s3:prefix": ["runner-e2e", "runner-e2e/*"] }
      }
    },
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject"],
      "Resource": "arn:aws:s3:::BUCKET/runner-e2e/*"
    }
  ]
}
```

Enable S3 versioning, default encryption, and Block Public Access. Disable
object ACLs. CloudFront receives read-only access through Origin Access Control;
the bucket itself stays private. Log S3 data writes and alert on attempts to
write outside the prefix or assume the role with a different subject.

Campaign prefixes are content-digested and immutable. The publisher refuses a
different digest at an existing campaign key. Only the compact history and
latest pointers are mutable, and S3 versioning makes those updates recoverable.

## Public evidence boundary

CloudFront and GitHub Pages are public. Prompts, model responses, screenshots,
fixture identifiers, timing, token usage, and costs are expected public data.
Credentials, Paperclip homes, databases, workspaces, master keys, raw logs, and
unallowlisted files are not. Each cell exact-value scans loaded secrets and key
shapes; the campaign publisher accepts only the generated dashboard, normalized
JSON/JUnit/summary, branding assets, and sanitized per-attempt evidence paths.
A leak fails the cell and withholds the unsafe file.

Rotate the affected credential immediately if a secret-scanning failure or
unexpected public object is observed. Preserve the private Actions artifact and
S3 object versions for incident analysis; do not weaken scanning to make a
campaign publish.
