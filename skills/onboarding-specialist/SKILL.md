---
name: onboarding-specialist
description: >
  Bootstrap a brand-new company on ValAdrien OS. Use on your very first
  heartbeat when you are a founding agent (CEO, Chief of Staff, or CTO) and
  your first task points at an existing repo (GitHub URL or local path) or asks
  you to "set up the company" / "onboard from this repo" / "bootstrap from this
  codebase". Walks you through four phases — discover, propose, confirm,
  execute — so the operator approves a PROFILE.md and AGENTS_ROSTER.md before
  you create other agents or modify company settings. Do NOT use this skill on
  routine tasks, after the company has already been onboarded, or if the
  operator did not give you a repo / company-setup intent.
---

# Onboarding Specialist

You are bootstrapping a brand-new company. Your operator (the human board user) wants the company set up quickly and correctly. This skill is the playbook.

## When to use

Load this skill on your **first heartbeat** if **all** of these are true:

- Your `role` is a founding role (`ceo`, `chief_of_staff`, or `cto`) — i.e. you
  are the first agent in this company and have full platform capabilities.
- Your first assigned task (`VALADRIEN_OS_TASK_ID`) either references an
  existing repo (GitHub URL or local path in the task body) or explicitly asks
  you to set up / onboard / bootstrap the company.
- The company does not yet have a `PROFILE.md` and `AGENTS_ROSTER.md` at the
  project root (you can check with the company-skills or storage API).

Re-load it on subsequent heartbeats if you need to refer back to the playbook.

Do **not** use this skill if:
- Another founding agent has already produced `PROFILE.md` and
  `AGENTS_ROSTER.md`. Onboarding is single-use per company.
- You are not the assignee on a setup/onboarding task.
- The operator has explicitly told you to skip the proposal step.

## The four phases

### Phase 1 — Discover

Read your assigned task description. Detect which of these inputs the operator provided:

| Input | Where to look | How to handle |
|---|---|---|
| GitHub URL | Task description, comments | Use the **GitHub scan playbook** below |
| Local path | Task description, comments | Use the **local scan playbook** below |
| Free-text description only | Task description, no path/URL | Use the **structured intake playbook** below |
| Nothing | Empty description | Post a polite "I need a starting point" comment and wait |

#### GitHub scan playbook

1. Extract `owner/repo` (and optional `ref`) from the URL.
2. Fetch `README.md` via the platform's safe-fetch endpoint (or, if unavailable, ask the operator to paste the README into a comment — never call the GitHub API directly with an auth token).
3. Fetch `package.json` / `pyproject.toml` / `go.mod` / `Cargo.toml` / `Gemfile` — whichever is present.
4. Fetch the top-level directory listing.
5. Look for: `LICENSE`, `CONTRIBUTING.md`, `.github/`, `.cursor/rules/`, `AGENTS.md`, `CLAUDE.md`.
6. Stop. You have enough to draft the PROFILE.

#### Local scan playbook

1. Verify the path is inside an allowed workspace root (the platform will reject paths outside the workspace).
2. Read the same files as the GitHub playbook from disk.
3. Do **not** execute anything. Do not run `npm install`, `git log`, `grep`, etc. Read-only.

#### Structured intake playbook

Post **one** comment on your task with these questions (numbered, plain language):

```
Hi! I'm the Onboarding Specialist. To set up your company I need a few facts:

1. **Company name** — what should we call it?
2. **One-sentence mission** — what is this company trying to do?
3. **Domain** — what industry / area? (e.g. fintech, internal tooling, e-commerce)
4. **Tech stack** — main languages and frameworks, if known
5. **First milestone** — what's the very first thing you'd want an agent to deliver?
6. **Operator name** — how should I address you?

Reply in a single comment; you can answer in any format you like.
```

Wait for the operator's reply before proposing.

### Phase 2 — Propose

Produce **two artifacts** in the project root:

#### `PROFILE.md` template

```markdown
# {Company Name}

> {One-sentence mission}

## What this company does

{2–4 sentence narrative grounded in what you found or were told}

## Operating facts

- **Industry / domain:** {…}
- **Primary stack:** {…}
- **Existing repo:** {URL or local path, or "none"}
- **License:** {…}
- **First milestone:** {…}

## Conventions

{Bullet list of any rules you extracted from CONTRIBUTING.md, .cursor/rules/, or operator answers. Leave empty if greenfield.}

## Glossary

{Domain terms the operator used that future agents will need. Skip if none.}

## Links

- {Repo URL if applicable}
- {Any other links the operator provided}
```

#### `AGENTS_ROSTER.md` template

```markdown
# Initial roster

Proposed agents to hire after the operator approves this file.

| # | Role | Name suggestion | Adapter | First task |
|---|------|-----------------|---------|------------|
| 1 | ceo | "CEO" | claude_local | Read PROFILE.md, set quarterly goals |
| 2 | … | … | … | … |

## Rationale

{One short paragraph explaining why this roster and not something bigger.}
```

**Roster heuristics:**

- **You are already hired.** Do not propose hiring another agent for your own
  role. The roster lists agents to hire *in addition to* you.
- If you are CEO and the codebase needs deep technical leadership → propose a CTO.
- If you are CTO/Chief of Staff and the operator wants someone to set
  strategy/comms → propose a CEO. Otherwise skip.
- If a code repo exists and there's no engineering peer in your roster → propose
  one engineer.
- If marketing/content is in the mission → propose a CMO.
- If the operator named ≤5 expected initial tasks → total agent count
  (including you) = 1–3. Don't propose 5+.
- Default adapter is `claude_local`. Only deviate if the operator specifically
  asked for another.

### Phase 3 — Confirm

1. Create a `request_confirmation` with:
   - Title: "Approve onboarding proposal for {company name}"
   - Body: short summary + links to `PROFILE.md` and `AGENTS_ROSTER.md`
   - Idempotency key: `confirmation:{issueId}:onboarding-proposal:{revision}`
2. Move your task to `in_review`.
3. Wait for the operator. If they comment with revisions, apply them to the markdown files and create a **fresh** confirmation with `revision = revision + 1`. Don't try to mutate the existing confirmation.

### Phase 4 — Execute

Only after the confirmation is accepted:

1. `PATCH /api/companies/{companyId}` with `name`, `description` (the one-sentence mission), and any other fields from PROFILE.md.
2. If PROFILE.md has a "First milestone" → create a company-level goal via `POST /api/companies/{id}/goals`.
3. For each row in AGENTS_ROSTER.md (excluding yourself):
   - Invoke the `valadrien-os-create-agent` skill with the role, name, and adapter from the table.
   - When the agent is created, create their first issue with the "First task" column as the title and a one-paragraph description.
4. Create a final issue assigned to **yourself** (the founding agent):
   - Title: `Onboarding handoff: take the wheel`
   - Description: list every artifact you produced, every agent you hired, and any open questions the operator still needs to answer.
5. Comment on your own onboarding task: `Onboarding complete. See {handoffIssueRef} for what's next.`
6. Set your onboarding task to `done`. Pick up the handoff issue on your next heartbeat.

## Safety checks

- Never push anything to a remote git host.
- Never run shell commands. If you find yourself wanting to, stop and ask the operator instead.
- Never store an operator's secret in PROFILE.md or any markdown file. Secrets go through the platform's secret store only.
- Never silently change a company's name or description. Every metadata change passes through the Phase 3 confirmation.

## Hand-off contract

When your task is `done`:

- `PROFILE.md` exists in the project root.
- `AGENTS_ROSTER.md` exists in the project root.
- The company's `name` and `description` match PROFILE.md.
- Each proposed agent (other than you) exists and has one open issue.
- A handoff issue exists, assigned to you.
- Your onboarding task has a final comment summarizing what was done.

If any of those aren't true, you're not done yet.
