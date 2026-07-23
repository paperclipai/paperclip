---
name: pr-to-green
description: >
  Ship committed work as a draft PR and drive it to merge-ready: clean branch
  off latest master, template-complete PR body, then iterate until CI checks
  pass, commitperclip gates clear, and Greptile is 5/5 — only then mark ready
  for review. Invoke only after the user explicitly asks to ship or push.
---

# PR to green

Take the current work product to a merge-ready pull request. The finish line is exact: **all CI checks green + commitperclip gates passing + Greptile 5/5 with no open P2s, recommendations, or follow-ups → then, and only then, flip the draft to "ready for review".**

This skill assumes you are in a checkout of the Paperclip repo with the changes committed locally, and that the user has explicitly asked to ship.

**Related skills** (`.agents/skills/`): this is the end-to-end shipping flow for session work; it composes narrower loops rather than replacing them. `prcheckloop` is the dedicated iterate-until-checks-green loop, `check-pr` inspects an existing PR for review comments / failing checks / body gaps, and `pr-report` summarizes PR state. If you are mid-flow and only need one of those steps, invoke that skill directly.

## 1. Build a clean branch off latest master

1. `git fetch origin master` and branch from `origin/master` — not from the session worktree's possibly-stale fork point.
2. Apply the session's changes onto it (cherry-pick or re-apply the diff). Squash fixup noise; keep logically separate changes as separate commits.
3. **No internal identifiers anywhere public:** branch name, commit messages, and PR body must not contain internal ticket ids (PAP-123 / PAPA-123), `agent://` links, instance-local URLs, or localhost/tailnet references. Branch names describe the change (`fix/...`, `docs/...`, `design/...`).
4. Re-run the local proof before pushing: `pnpm check:token-gates` (3/3 CLEAN if UI files changed), `pnpm typecheck`, and the relevant vitest suite(s).

## 2. Open as a DRAFT PR, template-complete

Read `CONTRIBUTING.md` and `.github/PULL_REQUEST_TEMPLATE.md`, then fill **every** section — the commitperclip bot rejects incomplete templates:

- **Thinking Path** — 5–8 blockquote steps from "what Paperclip is" down to this change.
- **Linked Issues or Issue Description** — either `Fixes:/Closes/Refs #NNN` (public GitHub only) or an in-PR description following the matching issue template. Search GitHub for duplicate/related PRs and link them.
- **What Changed** — one bullet per logical unit.
- **Verification** — the commands a reviewer can run, plus manual steps/screenshots for visual changes.
- **Risks** — honest; "Low risk" only if genuinely minor.
- **Model Used** — required: provider, exact model id, context window, thinking mode.
- **Checklist** — every box, truthfully.

For visual changes while snapshot baselines are dormant: state in the PR body that baselines are intentionally not updated, citing the `doc/design/DECISION-SHEET.md` entry "Per-change snapshot verification demoted to dormant (Jul 13 2026)" — so a missing baseline-manifest update reads as policy, not an oversight. Do not add the `storybook-visual` label unless the user asks for the visual CI run.

Open with `gh pr create --draft`.

## 3. Drive to green

Loop until done; report status to the user in plain language at each meaningful transition:

1. **CI checks:** watch `gh pr checks` (the `pr.yml` jobs: policy, typecheck/release-registry, sharded general tests incl. UI vitest, build, serialized server, canary dry-run, e2e). Fix failures at the root cause and push; never weaken a test to pass it. Never hand-edit `pnpm-lock.yaml` — the policy gate blocks manual lockfile edits (regenerate via pnpm if manifests changed).
2. **commitperclip:** the bot posts one consolidated comment (template, linked-issue, dedup-search, test-coverage, lockfile, dependency gates). Fix whatever it flags until it reports all checks passing.
3. **Greptile:** it reviews automatically on open/update. Address **every** comment — fix it, or reply with a concrete reasoned justification; never ignore or resolve-without-answer. Push fixes and let it re-review until the score is **5/5 with no open P2s, recommendations, or follow-ups**.
4. Re-check 1–3 after every push (a Greptile fix can break CI and vice versa).

If something is genuinely blocked on a human (a failing check unrelated to the change, a Greptile demand that contradicts the user's explicit decision), stop and report rather than forcing it.

## 4. Finish

When checks are green, commitperclip passes, and Greptile is 5/5 clean: `gh pr ready` to mark it ready for review, then give the user the PR URL and a one-paragraph plain-language summary of what shipped and what was verified. Merging stays with human maintainers.

## Installing this skill for Paperclip agents

Claude Code picks this skill up automatically via the committed symlink in `.claude/skills/`. To make it available to Paperclip's own agents: Skills page → "Scan project workspaces" (or `POST /api/companies/:companyId/skills/scan-projects`), then enable it per agent in the agent's Skills tab. Repo skills surface under two keys (project-scan `local/<hash>/...` plus adapter-native `paperclipai/paperclip/...`), so a bare slug is ambiguous when enabling via API — use the full key, e.g. `paperclipai/paperclip/pr-to-green`.
