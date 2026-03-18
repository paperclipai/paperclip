# Release Automation and Versioning Simplification Plan

## Context

Paperclip's current release flow is documented in `doc/RELEASING.md` and implemented through:

- `.github/workflows/release.yml`
- `scripts/release-lib.sh`
- `scripts/release-start.sh`
- `scripts/release-preflight.sh`
- `scripts/release.sh`
- `scripts/create-github-release.sh`

Today the model is:

1. pick `patch`, `minor`, or `major`
2. create `release/X.Y.Z`
3. draft `releases/vX.Y.Z.md`
4. publish one or more canaries from that release branch
5. publish stable from that same branch
6. push tag + create GitHub Release
7. merge the release branch back to `master`

That is workable, but it creates friction in exactly the places that should be cheap:

- deciding `patch` vs `minor` vs `major`
- cutting and carrying release branches
- manually publishing canaries
- thinking about changelog generation for canaries
- handling npm credentials safely in a public repo

The target state from this discussion is simpler:

- every push to `master` publishes a canary automatically
- stable releases are promoted deliberately from a vetted commit
- versioning is date-driven instead of semantics-driven
- stable publishing is secure even in a public open-source repository
- changelog generation happens only for real stable releases

## Recommendation In One Sentence

Move Paperclip to semver-compatible calendar versioning, auto-publish canaries from `master`, promote stable from a chosen tested commit, and use npm trusted publishing plus GitHub environments so no long-lived npm or LLM token needs to live in Actions.

## Core Decisions

### 1. Use calendar versions, but keep semver syntax

The repo and npm tooling still assume semver-shaped version strings in many places. That does not mean Paperclip must keep semver as a product policy. It does mean the version format should remain semver-valid.

Recommended format:

- stable: `YYYY.M.D`
- canary: `YYYY.M.D-canary.N`

Examples:

- stable on March 17, 2026: `2026.3.17`
- third canary on March 17, 2026: `2026.3.17-canary.2`

Why this shape:

- it removes `patch/minor/major` decisions
- it is valid semver syntax
- it stays compatible with npm, dist-tags, and existing semver validators
- it is close to the format you actually want

Important constraints:

- `2026.03.17` is not the format to use
  - numeric semver identifiers do not allow leading zeroes
- `2026.03.16.8` is not the format to use
  - semver has three numeric components, not four
- the practical semver-safe equivalent of your example is `2026.3.16-canary.8`

This is effectively CalVer on semver rails.

### 2. Accept that CalVer changes the compatibility contract

This is not semver in spirit anymore. It is semver in syntax only.

That tradeoff is probably acceptable for Paperclip, but it should be explicit:

- consumers no longer infer compatibility from `major/minor/patch`
- release notes become the compatibility signal
- downstream users should prefer exact pins or deliberate upgrades

This is especially relevant for public library packages like `@paperclipai/shared`, `@paperclipai/db`, and the adapter packages.

### 3. Drop release branches for normal publishing

If every merge to `master` publishes a canary, the current `release/X.Y.Z` train model becomes more ceremony than value.

Recommended replacement:

- `master` is the only canary train
- every push to `master` can publish a canary
- stable is published from a chosen commit or canary tag on `master`

This matches the workflow you actually want:

- merge continuously
- let npm always have a fresh canary
- choose a known-good canary later and promote that commit to stable

### 4. Promote by source ref, not by "renaming" a canary

This is the most important mechanical constraint.

npm can move dist-tags, but it does not let you rename an already-published version. That means:

- you can move `latest` to `paperclipai@1.2.3`
- you cannot turn `paperclipai@2026.3.16-canary.8` into `paperclipai@2026.3.17`

So "promote canary to stable" really means:

1. choose the commit or canary tag you trust
2. rebuild from that exact commit
3. publish it again with the stable version string

Because of that, the stable workflow should take a source ref, not just a bump type.

Recommended stable input:

- `source_ref`
  - commit SHA, or
  - a canary git tag such as `canary/v2026.3.16-canary.8`

### 5. Only stable releases get release notes, tags, and GitHub Releases

Canaries should stay lightweight:

- publish to npm under `canary`
- optionally create a lightweight or annotated git tag
- do not create GitHub Releases
- do not require `releases/v*.md`
- do not spend LLM tokens

Stable releases should remain the public narrative surface:

- git tag `v2026.3.17`
- GitHub Release `v2026.3.17`
- stable changelog file `releases/v2026.3.17.md`

## Security Model

### Recommendation

Use npm trusted publishing with GitHub Actions OIDC, then disable token-based publishing access for the packages.

Why:

- no long-lived `NPM_TOKEN` in repo or org secrets
- no personal npm token in Actions
- short-lived credentials minted only for the authorized workflow
- automatic npm provenance for public packages in public repos

This is the cleanest answer to the open-repo security concern.

### Concrete controls

#### 1. Use one release workflow file

Use one workflow filename for both canary and stable publishing:

- `.github/workflows/release.yml`

Why:

- npm trusted publishing is configured per workflow filename
- npm currently allows one trusted publisher configuration per package
- GitHub environments can still provide separate canary/stable approval rules inside the same workflow

#### 2. Use separate GitHub environments

Recommended environments:

- `npm-canary`
- `npm-stable`

Recommended policy:

- `npm-canary`
  - allowed branch: `master`
  - no human reviewer required
- `npm-stable`
  - allowed branch: `master`
  - required reviewer enabled
  - prevent self-review enabled
  - admin bypass disabled

Stable should require an explicit second human gate even if the workflow is manually dispatched.

#### 3. Lock down workflow edits

Add or tighten `CODEOWNERS` coverage for:

- `.github/workflows/*`
- `scripts/release*`
- `doc/RELEASING.md`

This matters because trusted publishing authorizes a workflow file. The biggest remaining risk is not secret exfiltration from forks. It is a maintainer-approved change to the release workflow itself.

#### 4. Remove traditional npm token access after OIDC works

After trusted publishing is verified:

- set package publishing access to require 2FA and disallow tokens
- revoke any legacy automation tokens

That eliminates the "someone stole the npm token" class of failure.

### What not to do

- do not put your personal Claude or npm token in GitHub Actions
- do not run release logic from `pull_request_target`
- do not make stable publishing depend on a repo secret if OIDC can handle it
- do not create canary GitHub Releases

## Changelog Strategy

### Recommendation

Generate stable changelogs only, and keep LLM-assisted changelog generation out of CI for now.

Reasoning:

- canaries happen too often
- canaries do not need polished public notes
- putting a personal Claude token into Actions is not worth the risk
- stable release cadence is low enough that a human-in-the-loop step is acceptable

Recommended stable path:

1. pick a canary commit or tag
2. run changelog generation locally from a trusted machine
3. commit `releases/vYYYY.M.D.md`
4. run stable promotion

If the notes are not ready yet, a fallback is acceptable:

- publish stable
- create a minimal GitHub Release
- update `releases/vYYYY.M.D.md` immediately afterward

But the better steady-state is to have the stable notes committed before stable publish.

### Future option

If you later want CI-assisted changelog drafting, do it with:

- a dedicated service account
- a token scoped only for changelog generation
- a manual workflow
- a dedicated environment with required reviewers

That is phase-two hardening work, not a phase-one requirement.

## Proposed Future Workflow

### Canary workflow

Trigger:

- `push` on `master`

Steps:

1. checkout the merged `master` commit
2. run verification on that exact commit
3. compute canary version for current UTC date
4. version public packages to `YYYY.M.D-canary.N`
5. publish to npm with dist-tag `canary`
6. create a canary git tag for traceability

Recommended canary tag format:

- `canary/v2026.3.17-canary.4`

Outputs:

- npm canary published
- git tag created
- no GitHub Release
- no changelog file required

### Stable workflow

Trigger:

- `workflow_dispatch`

Inputs:

- `source_ref`
- optional `stable_date`
- `dry_run`

Steps:

1. checkout `source_ref`
2. run verification on that exact commit
3. compute stable version from UTC date or provided override
4. fail if `vYYYY.M.D` already exists
5. require `releases/vYYYY.M.D.md`
6. version public packages to `YYYY.M.D`
7. publish to npm under `latest`
8. create git tag `vYYYY.M.D`
9. push tag
10. create GitHub Release from `releases/vYYYY.M.D.md`

Outputs:

- stable npm release
- stable git tag
- GitHub Release
- clean public changelog surface

## Implementation Guidance

### 1. Replace bump-type version math with explicit version computation

The current release scripts depend on:

- `patch`
- `minor`
- `major`

That logic should be replaced with:

- `compute_canary_version_for_date`
- `compute_stable_version_for_date`

For example:

- `stable_version_for_utc_date(2026-03-17) -> 2026.3.17`
- `next_canary_for_utc_date(2026-03-17) -> 2026.3.17-canary.0`

### 2. Stop requiring `release/X.Y.Z`

These current invariants should be removed from the happy path:

- "must run from branch `release/X.Y.Z`"
- "stable and canary for `X.Y.Z` come from the same release branch"
- `release-start.sh`

Replace them with:

- canary must run from `master`
- stable may run from a pinned `source_ref`

### 3. Keep Changesets only if it stays helpful

The current system uses Changesets to:

- rewrite package versions
- maintain package-level `CHANGELOG.md` files
- publish packages

With CalVer, Changesets may still be useful for publish orchestration, but it should no longer own version selection.

Recommended implementation order:

1. keep `changeset publish` if it works with explicitly-set versions
2. replace version computation with a small explicit versioning script
3. if Changesets keeps fighting the model, remove it from release publishing entirely

Paperclip's release problem is now "publish the whole fixed package set at one explicit version", not "derive the next semantic bump from human intent".

### 4. Add a dedicated versioning script

Recommended new script:

- `scripts/set-release-version.mjs`

Responsibilities:

- set the version in all public publishable packages
- update any internal exact-version references needed for publishing
- update CLI version strings
- avoid broad string replacement across unrelated files

This is safer than keeping a bump-oriented changeset flow and then forcing it into a date-based scheme.

### 5. Keep rollback based on dist-tags

`rollback-latest.sh` should stay, but it should stop assuming a semver meaning beyond syntax.

It should continue to:

- repoint `latest` to a prior stable version
- never unpublish

## Tradeoffs and Risks

### 1. One stable per UTC day

With plain `YYYY.M.D`, you get one stable release per UTC day.

That is probably fine, but it is a real product rule.

If you need multiple same-day stables later, you have three options:

1. accept a less pretty stable format
2. go back to a serial patch component
3. keep daily stable cadence and use canaries for same-day fixes

My recommendation is to accept one stable per UTC day unless reality proves otherwise.

### 2. Public package consumers lose semver intent signaling

This is the main downside of CalVer.

If that becomes a problem, one alternative is:

- use CalVer for the CLI package only
- keep semver for library packages

That is more complex operationally, so I would not start there unless package consumers actually need it.

### 3. Auto-canary means more publish traffic

Publishing on every `master` merge means:

- more npm versions
- more git tags
- more registry noise

That is acceptable if canaries stay clearly separate:

- npm dist-tag `canary`
- no GitHub Release
- no external announcement

## Rollout Plan

### Phase 1: Security foundation

1. Create `release.yml`
2. Configure npm trusted publishers for all public packages
3. Create `npm-canary` and `npm-stable` environments
4. Add `CODEOWNERS` protection for release files
5. Verify OIDC publishing works
6. Disable token-based publishing access and revoke old tokens

### Phase 2: Canary automation

1. Add canary workflow on `push` to `master`
2. Add explicit calendar-version computation
3. Add canary git tagging
4. Remove changelog requirement from canaries
5. Update `doc/RELEASING.md`

### Phase 3: Stable promotion

1. Add manual stable workflow with `source_ref`
2. Require stable notes file
3. Publish stable + tag + GitHub Release
4. Update rollback docs and scripts
5. Retire release-branch assumptions

### Phase 4: Cleanup

1. Remove `release-start.sh` from the primary path
2. Remove `patch/minor/major` from maintainer docs
3. Decide whether to keep or remove Changesets from publishing
4. Document the CalVer compatibility contract publicly

## Concrete Recommendation

Paperclip should adopt this model:

- stable versions: `YYYY.M.D`
- canary versions: `YYYY.M.D-canary.N`
- canaries auto-published on every push to `master`
- stables manually promoted from a chosen tested commit or canary tag
- no release branches in the default path
- no canary changelog files
- no canary GitHub Releases
- no Claude token in GitHub Actions
- no npm automation token in GitHub Actions
- npm trusted publishing plus GitHub environments for release security

That gets rid of the annoying part of semver without fighting npm, makes canaries cheap, keeps stables deliberate, and materially improves the security posture of the public repository.

## External References

- npm trusted publishing: https://docs.npmjs.com/trusted-publishers/
- npm dist-tags: https://docs.npmjs.com/adding-dist-tags-to-packages/
- npm semantic versioning guidance: https://docs.npmjs.com/about-semantic-versioning/
- GitHub environments and deployment protection rules: https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments
- GitHub secrets behavior for forks: https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets
