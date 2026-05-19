# Contributing Guide

Thanks for wanting to contribute!

We really appreciate both small fixes and thoughtful larger changes.

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
  - Before / After screenshots (or short video if UI/behavior change)
  - Clear description of what & why
  - Proof it works (manual testing notes)
  - All tests passing and CI green
  - Greptile score 5/5 with all comments addressed
  - [PR template](.github/PULL_REQUEST_TEMPLATE.md) fully filled out

PRs that follow this path are **much** more likely to be accepted, even when they're large.

## PR Requirements (all PRs)

### Use the PR Template

Every pull request **must** follow the PR template at [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md). If you create a PR via the GitHub API or other tooling that bypasses the template, copy its contents into your PR description manually. The template includes required sections: Thinking Path, What Changed, Verification, Risks, Model Used, and a Checklist.

### Model Used (Required)

Every PR must include a **Model Used** section specifying which AI model produced or assisted with the change. Include the provider, exact model ID/version, context window size, and any relevant capability details (e.g., reasoning mode, tool use). If no AI was used, write "None — human-authored". This applies to all contributors — human and AI alike.

### Tests Must Pass

All tests must pass before a PR can be merged. Run them locally first and verify CI is green after pushing.

### Greptile Review

We use [Greptile](https://greptile.com) for automated code review. Your PR must achieve a **5/5 Greptile score** with **all Greptile comments addressed** before it can be merged. If Greptile leaves comments, fix or respond to each one and request a re-review.

## Feature Contributions

We actively manage the core Paperclip feature roadmap.

Uncoordinated feature PRs against the core product may be closed, even when the implementation is thoughtful and high quality. That is about roadmap ownership, product coherence, and long-term maintenance commitment, not a judgment about the effort.

If you want to contribute a feature:

- Check [ROADMAP.md](ROADMAP.md) first
- Start the discussion in Discord -> `#dev` before writing code
- If the idea fits as an extension, prefer building it with the [plugin system](doc/plugins/PLUGIN_SPEC.md)
- If you want to show a possible direction, reference implementations are welcome as feedback, but they generally will not be merged directly into core

Bugs, docs improvements, and small targeted improvements are still the easiest path to getting merged, and we really do appreciate them.

## Virtual Office Feedback

Virtual Office is a beginner-friendly Paperclip workbench that may be tested by people who are new to agents, local models, or developer tooling.

If you are reporting Virtual Office feedback, use the GitHub issue form at [`.github/ISSUE_TEMPLATE/virtual-office.yml`](.github/ISSUE_TEMPLATE/virtual-office.yml), or copy the `Copy issue report` (`複製 issue 回報`) template from the Virtual Office checklist.

Good Virtual Office reports include:

- Your operating system.
- Whether the Office page opens.
- Backend / Frontend status, if you have it.
- The step where you got stuck.
- A short 3 to 5 line error summary.
- Which document or button was unclear.

Do not paste API keys, tokens, passwords, a full `.env`, full logs, private paths, private repository URLs, intranet URLs, or production customer/company/personal data.

Opening a Virtual Office issue is not authorization to install Hermes, press Run now, enable schedule triggers, or wake a local model. If you believe the report includes a security vulnerability, do not open a public issue; follow [SECURITY.md](SECURITY.md) instead.

If you open a Virtual Office pull request, use the Virtual Office verification block in [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md). In most cases, include `pnpm run office:verify`, a manual Office page or docs check, acceptance checklist updates, and a note that the PR did not install Hermes, press Run now, enable schedule triggers, wake a local model, or include secrets.

For a first small Virtual Office contribution, follow [the First Contribution SOP](docs/virtual-office-first-contribution.en.md). It keeps beginner-friendly docs, UI copy, checklist, and onboarding fixes scoped while preserving the Hermes, Run now, schedule, and production-data stop lines.

Maintainers reviewing Virtual Office PRs should use [the PR Review SOP](docs/virtual-office-pr-review.en.md) before merging. It checks scope, `pnpm run office:verify`, docs/UI/checklist sync, and the Hermes / Run now / schedule / secrets stop lines.

## General Rules (both paths)

- Write clear commit messages
- Keep PR title + description meaningful
- One PR = one logical change (unless it's a small related group)
- Run tests locally first
- Be kind in discussions 😄

## Writing a Good PR message

Your PR description must follow the [PR template](.github/PULL_REQUEST_TEMPLATE.md). All sections are required. The "thinking path" at the top explains from the top of the project down to what you fixed. E.g.:

### Thinking Path Example 1:

> - Paperclip orchestrates ai-agents for zero-human companies
> - There are many types of adapters for each LLM model provider
> - But LLM's have a context limit and not all agents can automatically compact their context
> - So we need to have an adapter-specific configuration for which adapters can and cannot automatically compact their context
> - This pull request adds per-adapter configuration of compaction, either auto or paperclip managed
> - That way we can get optimal performance from any adapter/provider in Paperclip

### Thinking Path Example 2:

> - Paperclip orchestrates ai-agents for zero-human companies
> - But humans want to watch the agents and oversee their work
> - Human users also operate in teams and so they need their own logins, profiles, views etc.
> - So we have a multi-user system for humans
> - But humans want to be able to update their own profile picture and avatar
> - But the avatar upload form wasn't saving the avatar to the file storage system
> - So this PR fixes the avatar upload form to use the file storage service
> - The benefit is we don't have a one-off file storage for just one aspect of the system, which would cause confusion and extra configuration

Then have the rest of your normal PR message after the Thinking Path.

This should include details about what you did, why you did it, why it matters & the benefits, how we can verify it works, and any risks.

Please include screenshots if possible if you have a visible change. (use something like the [agent-browser skill](https://github.com/vercel-labs/agent-browser/blob/main/skills/agent-browser/SKILL.md) or similar to take screenshots). Ideally, you include before and after screenshots.

Questions? Just ask in #dev — we're happy to help.

Happy hacking!
