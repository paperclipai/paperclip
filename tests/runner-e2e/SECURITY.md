# Runner E2E security for a public repository

This suite can spend provider money, expose four API credentials to isolated
test processes, publish a container, retain private visual evidence, and write
public structured evidence. Treat changes to the workflow, harness, fixture
prompts, evidence packager, and publisher as security-sensitive production
changes.

## GitHub authorization

Set `RUNNER_E2E_ALLOWED_ACTOR_IDS` to a non-empty JSON array of numeric GitHub
user IDs. Keep the list equal to the owners of `.github/**` in
`.github/CODEOWNERS`. For example, use `[123456,789012]`. Resolve each ID from
the authenticated CLI and verify the login before adding it:

```bash
gh api users/LOGIN --jq '{login,id}'
```

The paid workflows reject manual dispatches when the workflow definition does
not come from the default branch. A trusted dispatcher may name any branch in
`paperclipai/paperclip` as the code under test. The authorization job resolves
that branch through the GitHub API and passes only its immutable commit SHA to a
credential-free target-lock job. That job checks out the commit, regenerates
`pnpm-lock.yaml` once with lifecycle scripts disabled and lockfile-only mode,
then uploads the file under a run-attempt-scoped artifact ID. Catalog, image,
shared-build, provider-pack, and paid test jobs download that exact artifact by
ID, verify its recorded SHA-256, and restore it before setup or a frozen
dependency install. The lock resolver receives no provider credentials and
must never run repository lifecycle scripts. The shared-build and provider-pack
jobs also receive no provider credentials and disable dependency lifecycle
scripts; they package outputs with SHA-256 sidecars that consumers verify
before extraction. The paid test job installs with lifecycle scripts disabled,
and materializes the exact pinned OpenCode executable from its lockfile-verified
optional package without invoking package lifecycle code. Provider secrets are
scoped only to the final test step rather than dependency setup. Report sanitization and AWS
history publication explicitly use the trusted workflow commit and do not
consume the target lockfile. Never run the workflow definition from the target
branch.

The workflows verify both the original actor and triggering actor for every
scheduled or manual attempt, including human reruns. Every
secret-bearing job repeats this check as its first step so GitHub's partial-job
rerun feature cannot bypass a successful predecessor authorization job. The
legacy manually dispatched E2E workflow uses the same gate. Numeric IDs are
stable across username changes and prevent lookalike-name authorization.

The full-stack and live campaigns have one Sunday UTC schedule each and also
support explicit manual dispatch. Their legacy-named nightly repository
variables remain independent kill switches. Neither paid workflow accepts
pull-request, push, workflow-run, or reusable-workflow triggers.

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
`DAYTONA_API_KEY` in it. Do not duplicate these credentials as repository- or
organization-level Actions secrets: environment scoping is the boundary that
prevents branch or pull-request jobs from requesting them. Require approval
from an account in `RUNNER_E2E_ALLOWED_ACTOR_IDS` for this environment and
disable administrator bypass. The authorize, target-lock, catalog, image,
report, history, and Pages jobs receive none of these secrets.
Each full-stack matrix cell receives only its selected profile credential, plus
Daytona only for Daytona cells. Secret-bearing and OIDC jobs use frozen installs
without a shared dependency cache.
The Paperclip server process also receives none; the browser posts each value
once to the encrypted company secret API and agents/environments retain only
secret references.

Create `runner-e2e-history`, also default-branch-only, for the OIDC publishing
job. It contains no long-lived AWS key. Required reviewers may be added when a
human approval on every nightly publication is acceptable; otherwise rely on
the actor gate, environment branch restriction, and protected default branch.

## Runner fleet isolation

When `RUNNER_E2E_AWS_ENABLED=true`, paid matrix cells use the exact RunsOn fleet
selector `runs-on/fleet=paperclip-public-pr-x64/env=public-ci`, matching the AWS
fleet selected by `pr-trusted.yml` only after its stable numeric-ID trust gate.
Any other or missing toggle value falls back to the standard GitHub-hosted
`ubuntu-latest` runner and its lower concurrency ceiling. The workflow chooses
between those two reviewed literal labels; it never evaluates a configured
runner label.

Keep both runner targets restricted to `paperclipai/paperclip` and workflows
that independently authorize trusted source revisions. Never let a fork or
untrusted pull-request workflow target them. The RunsOn fleet must launch a
fresh ephemeral instance for every job, prohibit persistent runner reuse, and
disable interactive SSH/debug access unless a separate incident procedure
explicitly authorizes it.

Changing the runner does not widen who can authorize secret access. The paid
workflow still has only schedule and manual triggers, requires its trusted
definition to come from the protected default branch, requires allowlisted
stable actor IDs before checkout, and repeats that authorization as the first
matrix step. Provider credentials come only from the protected
`runner-e2e-paid` environment. The fleet selector is an exact workflow literal;
the only repository-controlled routing input is its boolean rollout switch, so
configuration cannot redirect a secret-bearing job to an arbitrary runner.

The optional target branch is code, not workflow authority. A CODEOWNER who
dispatches a target branch explicitly authorizes that branch's selected test
process to receive the cell's scoped provider credential. The workflow resolves
the target only inside the same repository, pins one SHA for the campaign, and
checks it out only after authorization. Target-controlled code cannot replace
the report sanitizer or the AWS history publisher. Fork refs and
target-controlled workflow definitions do not enter this path.

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

CloudFront and GitHub Pages are public. Fixture identifiers, timing, token
usage, costs, normalized results, and allowlisted inert structured per-attempt
evidence are expected public data. Screenshots, video, archives, generated
Playwright/blob/HTML report trees, credentials, Paperclip homes, databases,
workspaces, master keys, raw/unredacted logs, and unallowlisted files are not.
Only allowlisted `.log` copies that passed exact-value/key-shape scanning and
redaction may cross the public boundary.

The packaged evidence uploaded as a 30-day GitHub Actions artifact has a
different, access-controlled boundary. Text is exact-value and key-shape
scanned and redacted. PNG and WebM are raw-byte scanned but cannot be inspected
for credentials rendered as pixels, so they remain only in local evidence and
the access-controlled artifact. SVG is rejected during packaging because it is
active content.

Before permanent publication, the campaign publisher prunes raster/video
files, archives, and generated report trees. It then regenerates the dashboard
from the remaining allowlisted `.json`, `.log`, `.md`, and `.txt` evidence and
accepts only that dashboard, normalized JSON/JUnit/summary, fixed
branding assets, and the inert structured evidence paths. Per-attempt XML is
excluded because browsers can process XML/XSLT; the only public XML is the
root `junit.xml`, which the report aggregator constructs from fixed markup and
XML-escaped fields. The same pruned tree feeds both S3/CloudFront history and
the optional GitHub Pages artifact. A leak fails the cell and withholds the
unsafe file.

Rotate the affected credential immediately if a secret-scanning failure or
unexpected public object is observed. Preserve the access-controlled Actions
artifact and S3 object versions for incident analysis; do not weaken scanning
to make a campaign publish.
