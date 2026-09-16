# First-task onboarding assets

Everything the very first agent is told during onboarding lives here as plain
markdown so the board can edit the wording without touching TypeScript. The
server loads these files (see `server/src/services/onboarding-first-task-assets.ts`
and `server/src/services/onboarding-greeting.ts`) when it creates a new
organization's first task and when it hires the first agent.

## Files

| File | Layer | What it is |
| --- | --- | --- |
| `greeting.md` | C | The deterministic greeting the server posts as the agent on the first task, before anything runs. No LLM. |
| `opening-question.json` | C | The deterministic `ask_user_questions` card the server posts as the agent right after the greeting: "Interview me and propose a plan and an agent team to execute it." or "I have a task in mind" (free text). The option ids `interview` and `task` are fixed because `brief.md` refers to them; the `task` option must keep `freeText: true`. No LLM. |
| `brief.md` | A (steps 1, 3, 4) | The first task's description. Contains the `{{proposalStep}}` placeholder and tells the agent what to do with each answer to the opening card. |
| `proposal-confirmation.md` | A (step 2, task path) | The proposal instructions used when the plan-proposal toggle is **off** (default): a one-card `request_confirmation`. |
| `proposal-plan.md` | A (step 2, task path) | The proposal instructions used when the toggle is **on**: a short plan document plus a checkbox card. |
| `chief-of-staff/AGENTS.md` | B | The chief-of-staff persona seeded over the first agent's entry instruction file at hire time. |
| `README.md` | — | This file. |

## The opening card

`opening-question.json` is one single-select question. Its `prompt`, optional
`helpText`, optional `submitLabel`, and the two options' `label`/`description`
are free to edit. Picking an option only selects it; nothing happens until the
user presses the primary button (`submitLabel`, "Continue"). That is how every
question card behaves: Next / Submit answers, Skip (optional questions only),
and Cancel, which returns the plain composer and leaves the card pending. The server validates the file when it creates a first task
and refuses (logging a warning, the task is still created) if either option id
changes or the `task` option loses `freeText: true`. When the user answers, the
answer reaches the agent in its wake payload and `brief.md` step 1 tells it
which path to take; when the user types a message instead, the card expires
and the message wakes the agent as before.

## Placeholders

- `{{agentName}}` → the agent's chosen name. When the agent has no name the
  greeting drops the name gracefully ("I'm your first agent teammate"), matching
  the historical behaviour. Used in `greeting.md` and `chief-of-staff/AGENTS.md`.
- `{{organizationName}}` → the organization (company) name. Used in
  `chief-of-staff/AGENTS.md`.
- `{{proposalStep}}` (in `brief.md` only) → replaced with the contents of
  `proposal-confirmation.md` or `proposal-plan.md`, chosen by the
  `enableFirstTaskPlanProposal` toggle.

## The toggle

`enableFirstTaskPlanProposal` (Settings → Experimental, tier `preference`,
default **off** on cloud and self-hosted). Title: "First task: propose with a
plan document". When on, the first task's brief uses `proposal-plan.md` for the
single-task path so the chief of staff writes a short plan document and a
checkbox card instead of a one-card confirmation. The create route reads the
toggle **once**, when the first task is created; flipping it later does not
change an existing first task.

## Two rules

1. **Edits take effect on the next server restart locally, or the next release
   on cloud.** The files are read from disk (bundled into `dist/` at build
   time), not baked into TypeScript, so a plain markdown edit + restart/release
   is all that is needed.
2. **Only NEW organizations get new text.** An existing first task keeps the
   description it was created with, and an existing first agent keeps the
   persona it was seeded with (editable per agent under Instructions). Changing
   these files never rewrites text an existing organization already received.
