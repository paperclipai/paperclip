# Contributing Guide

Thanks for wanting to contribute!

We really appreciate both small fixes and thoughtful larger changes.

## Local Setup

### Prerequisites

Paperclip pins its toolchain. Mismatched versions are the most common cause of a
broken first install.

| Tool | Required | Check with |
| --- | --- | --- |
| Node.js | `>=24.11.0` (from `engines`) | `node --version` |
| pnpm | `9.15.4` (from `packageManager`) | `pnpm --version` |

If pnpm is missing or the version does not match:

```bash
npm install -g pnpm@9.15.4
```

If your Node distribution still ships Corepack, `corepack prepare pnpm@9.15.4
--activate` works too. Recent Node versions no longer bundle it, so the npm
install above is the reliable path.

### Fork and clone

Fork and clone in one step:

```bash
gh repo fork paperclipai/paperclip --clone --remote
```

```bash
cd paperclip
```

This gives you `origin` → your fork and `upstream` → `paperclipai/paperclip`.
Confirm it before you go further:

```bash
git remote -v
```

Push branches to `origin`, which is your fork. The push command under
[Branch Naming](#branch-naming) assumes this layout. Open pull requests against
`upstream/master`. Refresh your checkout with:

```bash
git pull upstream master
```

### Set your commit identity

Do this before your first commit. Git falls back to a global default or a
placeholder, and a commit authored by `Your Name <you@example.com>` cannot be
attributed to you — it has to be rewritten to fix.

```bash
git config user.name "Your Real Name"
```

```bash
git config user.email "your-github-email@example.com"
```

Confirm it took, and that it is not a placeholder:

```bash
git config user.name && git config user.email
```

### Install and verify

```bash
pnpm install
```

Then confirm the tree is healthy before changing anything:

```bash
pnpm typecheck
```

If `pnpm install` fails on workspace links, run `pnpm run preflight:workspace-links`
and read its output — `build`, `typecheck`, and `test:run` all run it first, so a
link problem surfaces everywhere until it is fixed.

For the full command reference — dev servers, builds, database migrations, e2e
suites — see the Development section of [README.md](README.md) and
[doc/DEVELOPING.md](doc/DEVELOPING.md). Do not duplicate those lists here.

### Environment

Local development needs no `.env` file. Leave `DATABASE_URL` unset. The server
then starts embedded PostgreSQL and persists data under `PAPERCLIP_HOME`. See
[doc/DEVELOPING.md](doc/DEVELOPING.md) for the data directory layout.

Do **not** copy `.env.example` for local work. That file describes a deployment
with external PostgreSQL. It points `DATABASE_URL` at `localhost:5432`, which no
local process serves, and it sets `SERVE_UI=false`, which disables the UI you are
trying to run.

Set a variable only when you must override a default. Never commit `.env`. In any
deployment, `BETTER_AUTH_SECRET` and `PAPERCLIP_TOOL_ACTION_SIGNING_SECRET` must be
real generated secrets, never the example placeholders.

## Before You Start: Search First

Before you start work, **search GitHub** for existing PRs and issues that touch the same area:

- Look for **duplicate or in-flight PRs**. If something close already exists, prefer helping that PR over the line (see [Helping Other Contributors](#helping-other-contributors)) instead of opening a parallel one.
- Look for **related open issues**. Link them in your PR body.
- If an older PR is effectively dead (stale, unmaintained, would be painful to rebase/merge), a fresh PR is fine — just call out the prior PR in your description so the reviewer has context.

Duplicate PRs create extra work for reviewers and make merging harder. A 60-second search saves hours later.

Affirm that you did this search by checking the dedup-search box in the PR template (`I have searched GitHub for duplicate or related PRs and linked them above`). Commitperclip checks for this checkbox on non-trivial PRs.

## Two Paths to Get Your Pull Request Accepted

### Path 1: Small, Focused Changes (Fastest way to get merged)

- Pick **one** clear thing to fix/improve
- Touch the **smallest possible number of files**
- Make sure the change is very targeted and easy to review
- All tests pass and CI is green
- Greptile score is 5/5 with all comments addressed
- Use the [PR template](.github/PULL_REQUEST_TEMPLATE.md)

These almost always get merged quickly when they're clean.

### Path 2: Bigger or Impactful Changes

- **First** talk about it in Discord → #dev channel  
  → Describe what you're trying to solve  
  → Share rough ideas / approach
- Once there's rough agreement, build it
- In your PR include:
  - Clear description of what & why
  - Proof it works (manual testing notes)
  - All tests passing and CI green
  - Greptile score 5/5 with all comments addressed
  - [PR template](.github/PULL_REQUEST_TEMPLATE.md) fully filled out

PRs that follow this path are **much** more likely to be accepted, even when they're large.

## PR Requirements (all PRs)

### Use the PR Template

Every pull request **must** follow the PR template at [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md). If you create a PR via the GitHub API or other tooling that bypasses the template, copy its contents into your PR description manually. The template includes required sections: Thinking Path, What Changed, Verification, Risks, Model Used, and a Checklist.

### Link Issues or Describe Them In-PR

We do not gate PRs on a pre-existing issue. Two acceptable paths:

1. **Issue exists** — search the [Issues database](https://github.com/paperclipai/paperclip/issues) for anything this PR addresses and tag each one with `Fixes: #123` / `Closes #123` / `Refs #123` so GitHub auto-links them. If there are **duplicate or closely related issues**, link all of them, not just the one you picked. If there are **related PRs** (prior attempts, dependent work, follow-ups, abandoned predecessors), link those too.
2. **No issue exists** — describe the problem directly in your PR body, following one of our [issue templates](.github/ISSUE_TEMPLATE/) so a reviewer has the same fields they'd get from a filed issue:
   - **Bug fix:** what happened, expected behavior, steps to reproduce, Paperclip version/commit, deployment mode. See [`bug_report.yml`](.github/ISSUE_TEMPLATE/bug_report.yml).
   - **Feature:** problem/motivation, proposed solution, alternatives considered, roadmap alignment. See [`feature_request.yml`](.github/ISSUE_TEMPLATE/feature_request.yml).
   - **New adapter:** agent or provider, why it's useful, how it's invoked. See [`adapter_request.yml`](.github/ISSUE_TEMPLATE/adapter_request.yml).

Either way, a reviewer should be able to understand the underlying issue without leaving the PR. Commitperclip may check that one of these two paths is satisfied. Only link **public** GitHub issues — see [No Internal Issue References](#no-internal-issue-references) for what to leave out.

### No Internal Issue References

Many contributors run their own Paperclip instance to manage their work. Issue ids and links from *your* instance are private — reviewers and other contributors cannot open them, so they show up as clutter or broken links.

In your PR title, description, commits, and comments, **only reference public GitHub issues and PRs** — `#123`, `Fixes #123` / `Closes #123` / `Refs #123`, or full `https://github.com/paperclipai/paperclip/...` URLs.

Do **not** include references to internal/instance-local Paperclip work, such as:

- Internal ticket ids like `PAPA-123`, `PAP-224`, or any `{PREFIX}-{NUMBER}` identifier that isn't a public GitHub issue number.
- Instance UI links such as `/PAP/issues/...`, `/PAP/agents/...`, `agent://...`, or document deep links.
- `localhost`, private IP, or tailnet URLs pointing at your own instance.

If an internal issue captured useful context, restate that context in plain English in the PR body instead of linking to it.

### Branch Naming

Tooling (including Paperclip) often names a working branch after an internal issue and task — e.g. `PAPA-42-why-did-this-break`. That name leaks instance-local context, isn't meaningful to reviewers, and ends up as the public branch on your PR.

Before you push, **rename the branch to something descriptive of the change itself**, not of your instance:

- Use short, kebab-case names scoped to the change, optionally with a conventional prefix: `docs/no-internal-issue-references`, `fix/sandbox-secret-resolution`, `feat/adapter-retry-backoff`.
- Do **not** include internal Paperclip ticket ids (`PAPA-123`, `PAP-224`), instance task slugs, or other instance-derived details in the branch name.

To rename and push under the new name:

```bash
git branch -m <descriptive-name>
git push -u origin <descriptive-name>
# If your tooling already pushed the old branch, delete it from origin:
git push origin --delete <old-name>
```

### Model Used (Required)

Every PR must include a **Model Used** section specifying which AI model produced or assisted with the change. Include the provider, exact model ID/version, context window size, and any relevant capability details (e.g., reasoning mode, tool use). If no AI was used, write "None — human-authored". This applies to all contributors — human and AI alike.

### Tests Must Pass

All tests must pass before a PR can be merged. Run them locally first and verify CI is green after pushing.

### Telemetry Changes

If your change adds, removes, or modifies emitted telemetry events, update the [Telemetry Data Contract](packages/shared/src/telemetry/README.md) in the same PR. Keep clients emitting raw dimension values and avoid documenting or relying on private delivery details.

### Paperclip Gates Must Pass

All Paperclip CI gates (lint, typecheck, tests, build, and any other required checks) must be satisfied before a PR can be merged. Don't ask for a merge while gates are red — fix them first.

### Greptile Review

We use [Greptile](https://greptile.com) for automated code review. Your PR must achieve a **5/5 Greptile score** before it can be merged, with:

- **No open P2 (or higher) comments**
- **No open recommendations**
- **No open follow-ups**

We hold the bar high here on purpose — we want code quality to be as high as possible. If Greptile leaves comments, fix them (or, if a comment is wrong, reply explaining why) and request a re-review.

## Before You Open a PR

Run these locally. CI runs the same gates, and a red gate blocks the merge.

```bash
pnpm typecheck
```

```bash
pnpm typecheck:build-gaps
```

```bash
pnpm test
```

```bash
pnpm build
```

CI runs `typecheck:build-gaps` as its own gate. `pnpm typecheck` can pass while
that gate fails, because it does not build the server or check for build and
typecheck coverage gaps. Run both.

`pnpm test` is the cheap Vitest run and does **not** include Playwright. If you
touched browser flows, run `pnpm test:e2e` as well and say so in your Verification
section.

Then check the diff itself:

```bash
git diff --check
```

This must print nothing. It flags trailing whitespace and leftover conflict
markers — both of which reviewers will otherwise catch for you.

Quote the actual output of what you ran in the PR's **Verification** section. "Tests
pass" without output is not verification.

### Name the branch for the change

Rename before you push if your tooling generated the branch name — see
[Branch Naming](#branch-naming). Descriptive and kebab-case, optionally prefixed:
`docs/setup-prerequisites`, `fix/sandbox-secret-resolution`,
`feat/adapter-retry-backoff`.

## Security Review Checklist

Complete this for any change that touches secrets, agent permissions, tool access,
sandboxes, auth, or user data. Anything unchecked blocks the merge.

### Secrets and credentials

- [ ] No hardcoded secrets, keys, tokens, or credentials.
- [ ] New secrets go through the Secrets Manager, not inline env or config.
- [ ] Logs, traces, and error messages exclude secret values and personal data.
- [ ] `.env`, state files, and fixtures containing real data stay uncommitted.

### Agent and tool boundaries

- [ ] Per-agent access is enforced on the object, not just the route.
- [ ] Tool access changes respect MCP Tool Gateway governance.
- [ ] Sandbox isolation is preserved; nothing new escapes to the host.
- [ ] Approval and review gates cannot be bypassed by the new path.

### Input and output

- [ ] External and agent-supplied input is validated before use.
- [ ] Database access is parameterized, never string-concatenated.
- [ ] Output is encoded for its destination.
- [ ] File paths, redirects, and outbound requests are checked for traversal and SSRF.

### Change safety

- [ ] Failure paths land in a safe, predictable state.
- [ ] The change is backward compatible, or the break is called out in Risks.
- [ ] Rollback is possible.
- [ ] Telemetry changes update the Telemetry Data Contract in the same PR.
- [ ] New dependencies are necessary, maintained, and free of known critical advisories.

## Helping Other Contributors

Fixing up someone else's stalled or almost-there PR is **strongly encouraged**. If a contributor has done most of the work but ran out of time or got stuck, picking up their branch, polishing it, and getting it over the line is one of the most valuable things you can do here.

When you do:

- Give credit. Mention the original author in the PR description and thank them.
- Preserve their commits where reasonable — don't squash them out of existence.
- Be kind in comments and reviews. People put real effort into their PRs, even the ones that didn't quite land.

A culture where contributors help each other ship is worth more than any single PR. Be generous with thanks.

## Feature Contributions

We actively manage the core Paperclip feature roadmap.

Uncoordinated feature PRs against the core product may be closed, even when the implementation is thoughtful and high quality. That is about roadmap ownership, product coherence, and long-term maintenance commitment, not a judgment about the effort.

If you want to contribute a feature:

- Check [ROADMAP.md](ROADMAP.md) first
- Start the discussion in Discord -> `#dev` before writing code
- If the idea fits as an extension, prefer building it with the [plugin system](doc/plugins/PLUGIN_SPEC.md)
- If you want to show a possible direction, reference implementations are welcome as feedback, but they generally will not be merged directly into core

Bugs, docs improvements, and small targeted improvements are still the easiest path to getting merged, and we really do appreciate them.

## General Rules (both paths)

- Write clear commit messages
- Keep PR title + description meaningful
- One PR = one logical change (unless it's a small related group)
- Run tests locally first
- Be kind in discussions 😄

## Writing a Good PR message

Write all PR text in Simplified Technical English (ASD-STE100): use short sentences, one instruction per sentence, simple approved vocabulary, and the active voice.

Your PR description must follow the [PR template](.github/PULL_REQUEST_TEMPLATE.md). All sections are required. The "thinking path" at the top explains from the top of the project down to what you fixed. E.g.:

### Thinking Path Example 1:

> - Paperclip is the open source app people use to manage AI agents for work
> - There are many types of adapters for each LLM model provider
> - But LLM's have a context limit and not all agents can automatically compact their context
> - So we need to have an adapter-specific configuration for which adapters can and cannot automatically compact their context
> - This pull request adds per-adapter configuration of compaction, either auto or paperclip managed
> - That way we can get optimal performance from any adapter/provider in Paperclip

### Thinking Path Example 2:

> - Paperclip is the open source app people use to manage AI agents for work
> - But humans want to watch the agents and oversee their work
> - Human users also operate in teams and so they need their own logins, profiles, views etc.
> - So we have a multi-user system for humans
> - But humans want to be able to update their own profile picture and avatar
> - But the avatar upload form wasn't saving the avatar to the file storage system
> - So this PR fixes the avatar upload form to use the file storage service
> - The benefit is we don't have a one-off file storage for just one aspect of the system, which would cause confusion and extra configuration

Then have the rest of your normal PR message after the Thinking Path.

This should include details about what you did, why you did it, why it matters & the benefits, how we can verify it works, and any risks.

Questions? Just ask in #dev — we're happy to help.

Happy hacking!
