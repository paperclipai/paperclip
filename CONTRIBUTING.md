# Contributing Guide

Thanks for wanting to contribute!

We really appreciate both small fixes and thoughtful larger changes.

## Two Paths to Get Your Pull Request Accepted

### Path 1: Small, Focused Changes (Fastest way to get merged)

- Pick **one** clear thing to fix/improve
- Touch the **smallest possible number of files**
- Make sure the change is very targeted and easy to review
- All automated checks pass (including Greptile comments)
- No new lint/test failures

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
  - All tests passing
  - All Greptile + other PR comments addressed

PRs that follow this path are **much** more likely to be accepted, even when they're large.

## General Rules (both paths)

- Write clear commit messages
- Keep PR title + description meaningful
- One PR = one logical change (unless it's a small related group)
- Run tests locally first
- Be kind in discussions 😄

## CI/CD and Lockfile Policy

**Important: Do NOT commit `pnpm-lock.yaml` changes in your pull requests.**

Paperclip uses an automated lockfile management system:

1. **Make your changes** to `package.json` files as needed
2. **Do NOT run `pnpm install`** or commit lockfile changes
3. **Submit your PR** with only the `package.json` changes
4. **CI will automatically regenerate** the lockfile during the policy check

### Why This Matters

- The policy check will **reject PRs** that include lockfile changes
- CI regenerates the lockfile to ensure consistency across all environments
- This prevents lockfile conflicts and ensures reproducible builds

### If You Accidentally Committed Lockfile Changes

Restore the lockfile to match master:

```bash
git checkout origin/master -- pnpm-lock.yaml
git commit -m "chore: remove lockfile changes per CI policy"
```

### CI Workflow

Your PR will go through these checks:

1. **Policy** - Validates Dockerfile dependencies and blocks manual lockfile edits
2. **Verify** - Runs typecheck, tests, and builds with CI-regenerated lockfile
3. **E2E** - Runs end-to-end tests
4. **Docker** - Validates Docker image builds (on master branch merges)

## Writing a Good PR message

Please include a "thinking path" at the top of your PR message that explains from the top of the project down to what you fixed. E.g.:

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
