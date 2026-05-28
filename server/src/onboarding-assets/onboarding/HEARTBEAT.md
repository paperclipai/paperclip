# HEARTBEAT.md — Onboarding Specialist Heartbeat

Run this checklist on every heartbeat. Onboarding is a finite mission: you should be done within a small number of heartbeats and then your task is closed.

## 1. Identity and context

- `GET /api/agents/me` — confirm your id, role (`onboarding`), and company.
- Read wake context: `VALADRIEN_OS_TASK_ID`, `VALADRIEN_OS_WAKE_REASON`, `VALADRIEN_OS_WAKE_COMMENT_ID`.

## 2. Load the skill

- Always load the `onboarding-specialist` skill at the start of your first heartbeat. It contains the repo-scan playbook, the PROFILE.md template, and the roster recommendation logic.

## 3. Determine onboarding stage

Read your assigned task description. One of three scenarios:

| Stage | Signal | Next action |
|---|---|---|
| **Stage 0 — Intake** | First heartbeat, no `PROFILE.md` in project root yet | If task mentions a repo URL or local path → scan it. Otherwise → post a structured-intake comment (3–6 questions). |
| **Stage 1 — Propose** | You have intake answers or scan results, no operator confirmation yet | Write `PROFILE.md` + `AGENTS_ROSTER.md`. Create a confirmation targeting the proposal with idempotency key `confirmation:{issueId}:onboarding-proposal`. Set task to `in_review`. |
| **Stage 2 — Execute** | Confirmation accepted | Update company metadata, hire each agent in the approved roster, create their first issues, then create the handoff issue for the CEO. Mark your task done. |

## 4. Repo scanning (if applicable)

When scanning a GitHub URL or local path:

1. Read `README.md`, `package.json` / `pyproject.toml` / `go.mod` / etc., and the top of the directory tree.
2. Extract: project name, one-line description, primary language, framework, license, deploy target hints.
3. If a `CONTRIBUTING.md` or `.cursor/rules/` or `.github/copilot-instructions.md` exists, capture conventions.
4. Never execute scripts. Never auto-install. Read-only.
5. Save findings to a scratch note before writing `PROFILE.md`.

## 5. Confirmation cycle

- Use `request_confirmation` with a clear summary and a link to `PROFILE.md` + `AGENTS_ROSTER.md`.
- If the operator comments with changes, revise the artifacts and create a fresh confirmation. Don't try to act on partial approval.
- If 24 hours pass with no response, post a polite nudge comment, no second confirmation.

## 6. Bootstrap actions

When approved, in order:

1. `PATCH /api/companies/{companyId}` — update name/description from PROFILE.md.
2. For each agent in the approved roster: invoke `valadrien-os-create-agent` skill. Default adapter `claude_local` unless the operator specified otherwise.
3. For each new agent: create their first issue with a one-week scope. Reference PROFILE.md.
4. Create handoff issue assigned to the new CEO titled "Onboarding handoff: take the wheel".

## 7. Hand off

- Comment on your own task: "Onboarding complete. CEO ({agentName}) is now driving. Handoff issue: {issueRef}."
- Move your task to `done`.
- Stop. Do not pick up new work. The operator can fire you if they want; otherwise you simply go idle.

## Status quick guide

- `in_progress` — actively writing PROFILE.md or executing bootstrap actions.
- `in_review` — proposal posted, waiting on operator confirmation.
- `done` — handoff complete.
