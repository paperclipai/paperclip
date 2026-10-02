# First-task onboarding assets

Everything the very first agent is told during onboarding lives here as plain
markdown so the board can edit the wording without touching TypeScript. The
server loads these files (see `server/src/services/onboarding-first-task-assets.ts`
and `server/src/services/onboarding-greeting.ts`) when it creates a new
organization's first task and when it hires the first agent. The first agent
also receives the bundled `first-task` skill through the normal company skill
inventory and agent skill assignment flow.

## Files

| File | Layer | What it is |
| --- | --- | --- |
| `greeting.md` | C | The deterministic greeting the server posts as the agent on the first task, before anything runs. No LLM. |
| `opening-question.json` | C | The deterministic `ask_user_questions` card the server posts as the agent right after the greeting: "Interview me and propose a plan and an agent team to execute it." or "I have a task in mind" (free text). The option ids `interview` and `task` are fixed because the `first-task` skill refers to them; the `task` option must keep `freeText: true`. No LLM. |
| `brief.md` | A | The first task's hidden description: a short `/first-task` invocation and the `{{proposalMode}}` selected at creation. |
| `skills/first-task/SKILL.md` | A (workflow) | The full first-task policy: opening-answer handling, interview, proposals, approval, and execution. Includes both single-task proposal modes. |
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
answer reaches the agent in its wake payload and the `first-task` skill tells it
which path to take; when the user types a message instead, the card expires
and the message wakes the agent as before.

## Placeholders

- `{{agentName}}` → the agent's chosen name. When the agent has no name the
  greeting drops the name gracefully ("I'm your first agent teammate"), matching
  the historical behaviour. Used in `greeting.md` and `chief-of-staff/AGENTS.md`.
- `{{organizationName}}` → the organization (company) name. Used in
  `chief-of-staff/AGENTS.md`.
- `{{proposalMode}}` (in `brief.md` only) → `confirmation` or `plan`, chosen by
  the `enableFirstTaskPlanProposal` toggle. The skill contains the policy for
  both modes; no policy text is expanded into the task description.

## The toggle

`enableFirstTaskPlanProposal` (Settings → Experimental, tier `preference`,
default **off** on cloud and self-hosted). Title: "First task: propose with a
plan document". When on, the first task's invocation selects `plan` mode for
the single-task path so the chief of staff writes a short plan document and a
checkbox card instead of a one-card confirmation. The create route reads the
toggle **once**, when the first task is created; flipping it later does not
change an existing first task.

## Skill assignment and invocation

The company skill service imports `skills/first-task/SKILL.md` with canonical
key `paperclipai/paperclip/first-task` and runtime name `first-task`. The agent
create and hire routes add it alongside the five core skills for board-created
`onboardingFirstAgent` agents on skills-capable adapters, including Codex and
Claude. Ordinary CEOs and other agents do not receive it automatically.

The hidden description asks the agent to read and follow the skill before
responding, including subsequent wakes on that task. The user does not need to
type a slash command. Native Codex sends the selected skill as a structured
skill input. Native ACPX Claude invokes the assigned skill through its native
`/first-task` command, with the complete task/wake envelope as the argument,
on initial and resumed turns. Legacy adapters retain the brief's instruction
to read the installed skill. None of these adds a separate model run. The skill
applies only to the onboarding task that invokes it, not to every task assigned
to that agent. The deterministic greeting,
opening card, and initial no-wake behavior are unchanged.

## Updates

1. **Edits take effect on the next server restart locally, or the next release
   on cloud.** The files are read from disk (bundled into `dist/` at build
   time), not baked into TypeScript, so a plain markdown edit + restart/release
   is all that is needed.
2. **Task descriptions and personas are snapshots.** An existing first task
   keeps the description it was created with, and an existing first agent keeps
   its seeded persona (editable per agent under Instructions). This change does
   not migrate existing first tasks or assign the skill to existing agents.
3. **Skill text follows normal bundled-skill refresh.** Agents assigned the
   unpinned `first-task` skill receive its current bundled contents through the
   company inventory. Its policy can therefore update independently of the
   saved invocation; the proposal mode remains the one stored on the task.
