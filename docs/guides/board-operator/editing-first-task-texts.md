---
title: Editing the First-Task Texts
summary: Change the welcome, instructions, and proposal style for new organizations
---

The text for a new organization's first task lives in `server/src/onboarding-assets/first-task/`. It is plain Markdown, so maintainers can change it without editing TypeScript.

## Files and placeholders

| File | Purpose |
| --- | --- |
| `greeting.md` | The welcome the user sees. |
| `brief.md` | The first-task instructions. Contains `{{proposalStep}}`. |
| `proposal-confirmation.md` | The single-card proposal used when the plan toggle is off. |
| `proposal-plan.md` | The plan document and checkbox-card proposal used when the toggle is on. |
| `opening-question.json` | The opening card: its prompt and two options. |
| `chief-of-staff/AGENTS.md` | The first agent's chief-of-staff persona. |
| `README.md` | A maintainer reference for the files, placeholders, toggle, and update behavior. |

The templates support `{{agentName}}`, `{{organizationName}}`, and `{{proposalStep}}`. Paperclip fills them when it creates the organization, first agent, and first task.

## How the first-task flow works

The server posts the greeting and an opening card with two options. Nothing runs until the user answers the card or writes a message.

- **Interview me:** the agent asks 3–4 questions in one card, then proposes a plan and a team.
- **I have a task in mind:** the typed text is the task. When it is clear enough, the agent proposes right away. Otherwise it asks 2–3 clarifying questions first.
- A plain message instead of an answer counts as a task.

The agent may create hires or tasks only after the user accepts a confirmation or checkbox card.

## Apply an edit

Edit the Markdown with GitHub's web editor or locally, open a pull request, and merge it. A local instance loads the change after its next server restart; Cloud tenants receive it with the next release.

Only new organizations receive updated text. An existing first task keeps its stored description, and an existing first agent keeps its instruction file. You can edit the task description on the task and the agent's copy in the app under **Instructions**.

## Choose the proposal form

Open **Settings > Experimental** and find **First task: propose with a plan document**. Its setting key is `enableFirstTaskPlanProposal`, and it is off by default.

- **Off:** the chief of staff answers a single-task request with one confirmation card.
- **On:** the chief of staff writes a short plan document and adds a checkbox card.

Paperclip reads this setting once, when it creates an organization's first task. Changing it later does not alter an existing first task.
