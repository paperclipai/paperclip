---
title: GitHub workflow & release policy
summary: PR pipeline, branch protection, deploy vs npm vs npx — aligned with current CI and releases
---

This document supersedes informal “New GitHub Workflow” checklists (e.g. board issue DLD-236). It matches **how the repo actually ships today**: GHCR-based VPS deploys, **decoupled** npm publishes, and **`npx` as the public CLI install path** for `@paperclipai/cli`.

## Goals

- Every production-impacting change is **reviewed in GitHub** (no silent hotfixes on hosts).
- **Roles stay separated**: developers produce work; one GitHub operator handles pushes/PR/merge; release and deploy are **explicit** actions.
- CI, optional AI review gates, and human approval for **high-risk** diffs stay enforceable.

## Three lanes (do not conflate them)

| Lane | What happens | Trigger |
|------|----------------|--------|
| **Merge / CI** | Code lands on the default branch after PR + required checks | PR merge |
| **VPS app deploy** | Docker image `ghcr.io/viraforge/paperclip:<sha>` is built in Actions; the Vultr host **pulls** that tag and recreates the server container | **`workflow_dispatch`** — [Deploy Vultr](https://github.com/Viraforge/paperclip/actions/workflows/deploy-vultr.yml) (not automatic on every push to `master`) |
| **npm / `npx`** | Packages publish under the **`@paperclipai`** scope; users run the CLI via **`npx`** + dist-tag (`canary` / `latest`) | **[Release](https://github.com/Viraforge/paperclip/actions/workflows/release.yml)** workflow (`workflow_dispatch`, plus nightly canary schedule) — **not** tied to merge |

**Invariant:** Merging to `master` **does not** deploy the VPS and **does not** publish npm. Shipping the app image and publishing packages are **deliberate** workflow runs. Details: [`doc/RELEASING.md`](../../doc/RELEASING.md).

## Public install surface (`npx`)

- The published CLI is **`@paperclipai/cli`** (binary: `paperclipai`). This is the same code path validated by release automation and Docker/onboarding smoke flows.
- **Canary:** e.g. `npx @paperclipai/cli@canary onboard` (see `doc/RELEASING.md` for exact commands and propagation notes).
- **Stable:** `npx @paperclipai/cli@latest …` (or the current stable dist-tag documented in `doc/RELEASING.md`).
- **Repo development** still uses `pnpm` workspaces (`pnpm dev`, `pnpm paperclipai …`). Docs and runbooks should not imply `pnpm install` is the only way operators install Paperclip — **`npx` is the portable, published path**.

npm registry propagation can lag several minutes after publish; CI allows for that (verify windows). Do not treat a failed immediate `npx` as a failed release until retries/timeouts are exhausted.

## Pull request workflow

End-to-end flow (human or agent developers):

1. **Developer** produces a commit-ready patch or instructions; does **not** push to GitHub unless explicitly granted.
2. **Senior Platform Engineer** (or other designated GitHub operator) pushes a branch and opens the PR.
3. **AI Code Reviewer** (when enabled) posts structured feedback and a verdict where required.
4. **Developer** prepares fix patches; **operator** applies commits to the PR branch (not a “relay” of review prose — fixes land as commits).
5. **Required checks** pass (`verify`, `policy`, and any repo-specific gates such as `ai-review/verdict` where configured).
6. **Operator** merges when policy allows (auto-merge only when branch protection and risk rules say so).

## Branch protection (principles)

For protected default branches (name may be `master` or `main` per repo):

- Require PR before merge.
- Require status checks to pass (at minimum **`verify`** and **`policy`** where used).
- Block force-pushes and direct pushes except for the governed operator model above.
- If **`ai-review/verdict`** (or similar) is required: plan a **bootstrap** for new repos or first workflows — e.g. post the status via the GitHub Statuses API, or temporarily adjust required checks until the reviewer can post. Avoid deadlocks where the first PR can never merge.

## Merge vs high-risk

Treat as **high-risk** (human approval, stricter scrutiny) when the diff materially touches:

- Authentication / session / tokens
- Authorization / RBAC / policy
- Secrets, env injection, or credential handling
- **`.github/workflows/`**, Dockerfiles, compose, deploy scripts, or production orchestration
- Infrastructure (Terraform, k8s, reverse proxies, etc.)
- Database migrations or destructive data operations
- Billing / payments

Auto-merge (if used) should apply only when CI is green, risk is not elevated, and review verdict allows it.

## Platform Engineer (GitHub operator)

The operator is the only role that should routinely:

- Push branches and updates
- Open / edit PRs
- Merge (subject to branch protection)
- **Trigger** `Deploy Vultr` and **trigger** npm **Release** workflows when leadership agrees

Developers:

- Implement and respond to review
- Produce fix patches
- Do **not** hold org-wide GitHub tokens unless explicitly approved for a narrow task

## Monitoring (suggested)

- Time from PR open to first substantive review
- PRs blocked on failed checks or `BLOCK` verdicts
- Issues caught before merge (severity counts)
- Post-deploy regressions tied to recent merges
- **Deploy** success and image tag on the host vs expected `github.sha`
- **`npx @paperclipai/cli@<dist-tag>`** smoke after publish when releasing user-facing CLI changes

## Related docs

- [`doc/RELEASING.md`](../../doc/RELEASING.md) — npm channels, `npx` commands, stable/changelog expectations
- [`.github/workflows/deploy-vultr.yml`](../../.github/workflows/deploy-vultr.yml) — GHCR build + SSH deploy
- [`.github/workflows/release.yml`](../../.github/workflows/release.yml) — canary/stable publish
- [`AGENTS.md`](../../AGENTS.md) — production change policy (GitHub-only path)
