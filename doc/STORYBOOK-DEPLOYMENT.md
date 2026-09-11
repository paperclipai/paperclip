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
