---
name: github-actions-maintenance
description: >
  Audit and update GitHub Actions to current versions. Detect deprecated Node.js runtimes, stale action tags, and known-vulnerable action pins in workflow files. When to use: CI warnings about deprecated Node versions, scheduled action audits, or when opening a repo with workflow files.
key: paperclipai/bundled/software-development/github-actions-maintenance
recommendedForRoles:
  - engineer
tags:
  - github-actions
  - ci-cd
  - workflow
  - nodejs
  - maintenance
---

# GitHub Actions Maintenance

Keep workflow files on current, supported action versions and avoid deprecated Node.js runtimes.

## When to use

- GitHub Actions logs warn about deprecated Node.js versions (e.g. "Node.js 20 is deprecated").
- A CI run fails or shows deprecation warnings for action versions.
- Periodic audit of workflow files (quarterly or before a release).
- A repo's first setup — seed workflows with current action versions from the start.

## When not to use

- The workflow uses only third-party actions with no `actions/*` involvement.
- The repo is archived or read-only.

## Audit steps

1. **Find all workflow files**: `**/.github/workflows/*.yml` and `**/.github/workflows/*.yaml`.
2. **Extract every `uses:` reference** and note the action slug and version tag.
3. **Classify each action**:

   | Classification | Action |
   |---|---|
   | GitHub-owned (`actions/*`) | Check the official repo's README for latest major tag and Node.js runtime. |
   | Marketplace popular (e.g. `softprops/*`, `dawidd6/*`) | Check the repo's README or releases page for latest major version. |
   | Unknown / low-star third-party | Note for manual review; do not auto-update without checking repo health. |

4. **Identify deprecation signals**:
   - Node.js runtime warnings in CI logs (Node.js 16, 20 → must upgrade).
   - Action README states the current major requires a newer Node runtime.
   - Action major version is more than one behind latest (e.g. `@v3` when `@v7` exists).

5. **Update outdated actions**:
   - For `actions/*`: bump to the latest major version that uses Node.js 24 (`@v7` as of mid-2026).
   - For third-party actions: bump to the latest stable major release.
   - Always verify the changelog for breaking changes between major versions.
   - Prefer pinned major tags (`@vN`) for the actions you actively track and audit, since they make updates easier to apply and review.
   - For supply-chain hardening, prefer immutable commit-SHA pins when the repo policy calls for maximum reproducibility, or when an action's tag can be reassigned.

## Common action version mappings (as of mid-2026)

| Action | Current Node.js 24 version |
|---|---|
| `actions/checkout` | `@v7` |
| `actions/upload-artifact` | `@v7` |
| `actions/download-artifact` | `@v5` |
| `actions/setup-python` | `@v7` |
| `actions/setup-node` | `@v5` |
| `actions/cache` | `@v4` (Node.js 20 compatible) |
| `softprops/action-gh-release` | `@v3` |
| `dawidd6/action-download-artifact` | `@v6` |

> **Important**: These versions drift. Always verify against the action's README or releases page before updating.

## Breaking change checklist

When bumping a major version, verify:

- **Inputs/outputs**: no renamed or removed inputs; no new required inputs.
- **Permissions**: the action may need different `permissions` block scopes.
- **Runner version**: some actions require a minimum Actions Runner version (e.g. `v2.327.1+` for Node.js 24 actions).
- **Container compatibility**: if the workflow uses `container:`, verify the action still works inside the container image.
- **Artifact format changes**: `actions/upload-artifact@v4+` uses a different format than v3; download-side must match.

## Verification

After updating:

1. Push the changes and wait for CI to run.
2. Confirm no deprecation warnings in the workflow logs.
3. Confirm all jobs pass.
4. If a workflow uses `workflow_run` to download artifacts from another workflow, verify the artifact name and format still match.

## Preventive measures for new workflows

When creating new workflow files:

- Always start with the latest major version of each action.
- Add a comment with the date of the last action version audit.
- Consider pinning to a specific minor version (e.g. `@v7.0.0`) for reproducibility, with a note to review quarterly.

## Anti-patterns

- Using `@v3` or older for `actions/*` — these use Node.js 16 and are fully deprecated.
- Using `actions/upload-artifact@v3` or older — these are deprecated and use an outdated artifact format.
- Mixing artifact action versions (e.g. upload with `@v4` but download with `@v3`) — formats are incompatible.
- Floating to `@main` or a branch name — this is unreliable and can break without notice.
