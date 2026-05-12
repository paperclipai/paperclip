# GIT-WORKFLOW.md

## Purpose

Defines the branching strategy and git workflow at Allkey. All agents with GitHub access follow this.

**Owner**: CTO
**Read by**: CTO, SWE, Tech Lead, Security Engineer, UX Designer

## Branch Structure

```
main
  └── feature/ALL-XXX-brief-description   (one per parent issue)
  |     └── feature/ALL-YYY-child-task       (optional sub-branch for parallel child work)
  └── fix/ALL-XXX-brief-description        (bug fixes)
```

## Branch Rules

### `main`

- **Protected**: no direct commits. All changes via PR.
- Requires: PR + Tech Lead approval + CI passing
- Represents production-ready code at all times

### `feature/ALL-XXX-brief-description`

- One branch per **parent** Paperclip issue
- Created by CTO when kicking off implementation
- All child issues (if sequential) work on this branch
- For parallel child work: create sub-branches (`feature/ALL-YYY-...`) off the feature branch, merge sub-branches back into the feature branch (not main), then merge the feature branch to main when complete
- Naming: `feature/ALL-521-environment-optimization`

### `fix/ALL-XXX-brief-description`

- Bug fix branches
- Branch from `main`
- Merge back to `main` after Tech Lead review + approval
- Naming: `fix/ALL-488-login-redirect`

## Standard Workflow

### Starting a Feature

```bash
git checkout main && git pull
git checkout -b feature/ALL-XXX-brief-description
git push -u origin feature/ALL-XXX-brief-description
```

### Finishing a Child Issue

```bash
git add <specific files>
git commit -m "[ALL-YYY] What changed and why"
git push
# Open PR from feature branch to main (or sub-branch to feature branch)
```

### Merging (Tech Lead)

```bash
# After approving the PR:
gh pr merge <PR number> --squash --delete-branch
```

Use squash merge to keep main history clean.

## Commit Message Format

```
[ALL-XXX] Short description (imperative mood)

Optional longer explanation of WHY, not WHAT.
```

## When to Add a `develop` Branch

Start simple: feature branches → main. Add a `develop` integration branch only if:
- Multiple large features need to be integrated before a scheduled release
- Release cadence requires a staging buffer between feature-complete and production

CTO decides when this threshold is reached.

## Agent Responsibilities

- **CTO**: creates feature branches, manages branch lifecycle, reviews for architectural conflicts between concurrent feature branches
- **SWE**: works on the assigned branch, opens PRs, addresses review feedback
- **Tech Lead**: reviews PRs, approves, merges after approval
- **Security Engineer / UX Designer**: work on the feature branch for their contributions; open sub-PRs if needed
