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

Every pull request **must** follow the PR template at [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md). If you create a PR via the GitHub API or other tooling that bypasses the template, copy its contents into your PR description manually. The template includes required sections: Thinking Path, What Changed, Verification, Risks, and a Checklist.

### Tests Must Pass

All tests must pass before a PR can be merged. Run them locally first and verify CI is green after pushing.

### Greptile Review

We use [Greptile](https://greptile.com) for automated code review. Your PR must achieve a **5/5 Greptile score** with **all Greptile comments addressed** before it can be merged. If Greptile leaves comments, fix or respond to each one and request a re-review.

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
