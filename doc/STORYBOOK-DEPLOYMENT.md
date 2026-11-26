# Storybook branch hosting

The `Storybook Deploy` workflow publishes public static Storybook builds to the
existing private S3 bucket behind CloudFront. It does not deploy to GitHub Pages.

## Current destination

- AWS account: `078455283791`, region `us-east-1`
- Bucket: `paperclipai-runner-e2e-history-078455283791-us-east-1`
- Allowed upload prefix: `storybook/branches/`
- Distribution: `E3GTU28BBO2SFR`
- Public origin: `https://d1p6rlowie26tp.cloudfront.net`
- Role: `arn:aws:iam::078455283791:role/paperclip-storybook-github`

The distribution's default behavior disables edge caching and rewrites directory
URLs to `index.html`. Stable branch indexes send `no-cache`; unique build objects
send `immutable`. No invalidations or CloudFront write permissions are needed.

Each publication updates a readable bookmark, such as
`https://d1p6rlowie26tp.cloudfront.net/storybook/branches/master/`, after the
immutable build upload completes. It also updates the previous hashed branch
entry for compatibility. The run summary and Markdown artifact link the bookmark.
Branch names use one escaped path segment, preserving case and separating slashes
from hyphens; see [the branch publishing guide](#publish-a-branch-storybook)
for the encoding. No additional AWS permissions or distribution changes are needed.

## GitHub configuration

Create environment `storybook-deploy` with required reviewers set to the
individual CODEOWNERS accounts. Disable administrator bypass, allow self-review,
and allow repository branches. Keep these reviewers synchronized with CODEOWNERS.
The workflow rejects environments with no required reviewers, non-owner reviewers
or administrator bypass enabled. The AWS role trusts only this repository and
this environment, so a branch cannot obtain upload access through an unprotected
environment.

Set repository variables:

| Variable | Value |
| --- | --- |
| `STORYBOOK_AWS_ROLE_ARN` | `arn:aws:iam::078455283791:role/paperclip-storybook-github` |
| `STORYBOOK_AWS_REGION` | `us-east-1` |
| `STORYBOOK_S3_BUCKET` | `paperclipai-runner-e2e-history-078455283791-us-east-1` |
| `STORYBOOK_PUBLIC_BASE_URL` | `https://d1p6rlowie26tp.cloudfront.net` |

No stored AWS access keys are needed. Leave the runner dashboard variables and
GitHub Pages configuration unchanged.

## Operator setup

Use the `paperclip-dev` operator AWS profile. Review the checked-in policies in
`.github/storybook-deploy/` before applying them. The existing GitHub OIDC provider
must be present in this account.

```sh
aws sts get-caller-identity --profile paperclip-dev
aws iam create-role --profile paperclip-dev \
  --role-name paperclip-storybook-github \
  --assume-role-policy-document file://.github/storybook-deploy/trust-policy.json
aws iam put-role-policy --profile paperclip-dev \
  --role-name paperclip-storybook-github --policy-name StorybookBranchUpload \
  --policy-document file://.github/storybook-deploy/upload-policy.json
```

For an existing role, use `update-assume-role-policy` instead of `create-role`.
Add the statement from `cloudfront-read-statement.json` to the existing bucket
policy's `Statement` array. Preserve every other statement, including the HTTPS
requirement and runner report access. Keep all S3 public-access blocks enabled;
only CloudFront receives read access to this public-content prefix.

The role has no delete, bucket policy, IAM, CloudFront, or root-object permissions.
The workflow never runs `sync --delete`. Builds accumulate; any retention cleanup
must preserve the build referenced by each branch entry.

## Verification

```sh
node --test scripts/__tests__/storybook-deploy.test.mjs
actionlint .github/workflows/storybook-deploy.yml .github/workflows/storybook-visual.yml
```

Dispatch two source branches, approve each deployment, and check their distinct
branch URLs and each build's `deployment.json`. Redeploy one branch and confirm
its stable URL now points to the new build while the other branch is unchanged.
The publisher checks the public build metadata against the selected source SHA
and verifies that the public branch entry points to this exact build. It retries
brief propagation delays and fails if the branch URL remains stale.

## Publish a branch Storybook

CODEOWNERS can publish a repository branch through **Actions → Storybook Deploy →
Run workflow**. Keep the workflow branch on `master` and enter the source branch
in `branch`. The source branch does not need to contain the workflow. Leaving
`branch` empty publishes the selected workflow branch's dispatched commit.

```sh
gh workflow run storybook-deploy.yml --ref master -f branch=your-branch
```

The existing **Storybook Visual** workflow also offers a `deploy_preview` checkbox,
which publishes through the same workflow instead of running visual tests:

```sh
gh workflow run storybook-visual.yml --ref master -f deploy_preview=true -f branch=your-branch
```

Approve the `storybook-deploy` environment as a CODEOWNER. The workflow summary
links the **stable branch URL** and **this build**. The run also uploads a
`storybook-deployment-<run-id>-<attempt>` artifact containing
`storybook-deployment.md` with both links and the source commit. Different branches have
different URLs; publishing one never replaces another. Redeploying the same
branch updates its stable URL only after all files for the new build are uploaded.
Previous build links keep working. The branch entry preserves Storybook query
parameters and fragments when redirecting to the completed build.

Bookmark URLs use `storybook/branches/<branch>/`, for example
`https://d1p6rlowie26tp.cloudfront.net/storybook/branches/master/`.
Copy the **stable branch URL** from the run summary when saving a bookmark;
opening it redirects to the latest published build. Branch names preserve case.
Characters other than letters, digits, `_`, and `-` use `~HH` UTF-8 escapes, so
`feature/foo` becomes `feature~2Ffoo` and stays distinct from `feature-foo`.
Names ending in a hyphen and 16 lowercase hex digits escape that hyphen to
reserve the existing build directories. Very long names use a hash suffix.
Existing hashed branch URLs keep updating and remain valid. Build files remain
under `storybook/branches/<readable-branch>-<hash>/builds/<run-id>-<attempt>/`.
`deployment.json` in each build records its branch, source commit and URLs.
Builds run independently; publication is serialized per branch. Retained builds
are not automatically deleted and will accumulate until an operator prunes them.

Publishing requires both the original actor and the current rerunner to be
individual GitHub accounts named in `.github/CODEOWNERS` on the current default
branch. Individual accounts from every ownership rule are included, regardless
of which paths they own. Comments, teams and email entries do not grant access.
Authorization runs before the build and again before deployment, including
deployment-only reruns.
GitHub also requires a CODEOWNER environment approval, so editing authorization
code on a branch cannot grant AWS access without an authorized reviewer.
CODEOWNERS membership does not automatically add an account to the environment's
required reviewers; a configured reviewer must approve each deployment.

The build downloads the public source archive with no GitHub token permissions,
AWS credentials or repository secrets. Dependency caching and install lifecycle
scripts are disabled. The separate publisher uses GitHub OIDC to assume a role limited to
`storybook/branches/*`. It treats the build artifact as static files and runs only
the publisher from the workflow checkout. It cannot delete objects, change AWS
settings, or overwrite the runner dashboard. The Storybook site itself is public.
Pushes and PR events never publish it.

The existing S3 bucket and CloudFront distribution also serve runner reports in
separate prefixes. GitHub Pages and its dashboard workflow are independent.
See the setup sections above for the environment,
repository variables, AWS policies and one-time operator setup.

GitHub requires a new dispatch workflow to exist on the default branch before
it becomes a manual entry point.
