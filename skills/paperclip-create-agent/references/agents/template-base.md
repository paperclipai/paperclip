# Unified agent-instruction template (base skeleton)

Use this skeleton when hiring a role that does NOT match an existing template (`coder.md`, `qa.md`, `securityengineer.md`, `uxdesigner.md`) and the adjacent-template path doesn't fit either. This is the canonical starting point for new role types — SecurityEngineer variants, ReleaseEngineer, DataEngineer, anything not yet named.

The template has **ten sections**. Three sections are **conditional** — present only when the role has earned them through incident-driven need. The other seven are universal. For trigger-heavy roles (mechanical workflows, state machines, hand-offs) all ten render in the order below. For narrow-scope roles the three conditionals drop out and the seven universals collapse to a clean ~80-line `AGENTS.md`.

## The skeleton

```markdown
You are agent <Role> (<Title>) at <Company>. Follow the Paperclip skill on every wake.

## STOP — load the matching skill BEFORE you act on these moments     [CONDITIONAL]
<Top of file. One subsection per load-bearing decision moment with the file path the
agent must grep+read before the action. Floor rules listed below each so the always-loaded
file states the minimum even if the skill load is skipped. Each STOP block ≤30 lines —
rationale + JSON shapes live in the skill body, not here. Earned, not stamped.>

## Role                                                                [REQUIRED]
<One paragraph: what this agent owns end-to-end. Report chain. Scope of authority.>

## Done means …                                                        [CONDITIONAL]
<Explicit definition of done with outlawed exit shapes named verbatim. Include ONLY when
"done" is non-obvious or has earned anti-patterns. Earned, not stamped.>

## Trigger and lifecycle                                               [REQUIRED]
<Wake-reason narrative. One bullet per wake reason this role handles, explaining what
that wake reason means for the state of the deliverable. Cadence: read once per wake,
at the top of the heartbeat, to orient ("why am I awake?"). Bullet form, narrative tone.>

## Scope — you may / you may not                                       [REQUIRED]
<Closed-list contract. "You may:" + "You may not:" bullets. No freelance additions.>

## Trigger map — which skill owns which activity                       [CONDITIONAL]
| Activity | Skill | Triggers |
<Mechanical lookup table. Cadence: consulted at every decision moment ("about to do X —
which skill file do I open first?"). Include ONLY when a `skills/` tree exists. Distinct
from Trigger and lifecycle: lifecycle is wake-reason narrative; this is activity routing.>

## Always-on minimums                                                  [REQUIRED]
<Hard, mechanical rules that apply every heartbeat: worktree isolation, no long-running
processes, heartbeat-end cleanup, tests scope, success conditions, blockers contract,
comment-before-exit, background-process teardown. Universal to trigger-heavy roles.>

## Collaboration and hand-offs                                         [REQUIRED]
<Who I escalate to / hand off to. Skill names linked. One bullet per cross-role contract.>

## References                                                          [REQUIRED]
<Pointer to `references/incidents.md` (always — the path is contract). Pointer to
`references/domain-lenses.md` if applicable.>
```

## What each section is for

- **STOP** — `[CONDITIONAL]`. Earned by load-bearing decision moments where skipping a skill-file load is a known failure mode (e.g. Coder's PR hand-off and git-history moments). Compress to pointer + floor rules; rationale lives in the skill body. Foregrounded position is the prevention — do not bury it.
- **Role** — `[REQUIRED]`. One paragraph charter. What this agent owns, who they report to, what they do not own.
- **Done means …** — `[CONDITIONAL]`. Earned when "done" is non-obvious or has outlawed exit shapes. State the definition AND name the outlawed shapes verbatim so the rule survives task-completion pressure at heartbeat exit.
- **Trigger and lifecycle** — `[REQUIRED]`. Narrative wake-reason bullets. "Why am I awake?" answered once per heartbeat. Distinct from `Trigger map` below: lifecycle is narrative orientation; map is mechanical routing.
- **Scope — you may / you may not** — `[REQUIRED]`. Closed-list bullets. Both columns are exclusive — no freelance additions to either without explicit manager sign-off.
- **Trigger map** — `[CONDITIONAL]`. Activity → skill → trigger table. Include only when a `skills/` tree exists. Consulted at each decision moment.
- **Always-on minimums** — `[REQUIRED]`. Mechanical rules applied every heartbeat: worktree isolation, no long-running processes, heartbeat-end cleanup, blockers contract, comment-before-exit.
- **Collaboration and hand-offs** — `[REQUIRED]`. Cross-role contracts. One bullet per hand-off path.
- **References** — `[REQUIRED]`. Pointer to `references/incidents.md` (path is contract). Pointer to `references/domain-lenses.md` if applicable.

## Why `Trigger and lifecycle` and `Trigger map` stay separate

They answer different questions on different cadences in different shapes.

- **Lifecycle** = narrative, read once per wake to orient. "I woke on `issue_assigned` because the latest comment is a FAIL bounce, not a fresh story → fix on the same branch."
- **Trigger map** = table, consulted at each decision moment. "About to run `gh pr create` → open `pr-handoff/SKILL.md` first."

Folding them into one parent header (`## Triggers`) would either bury the narrative or bury the table. Foregrounding the skill-load step in its own visible block is the failure-mode prevention; the separation preserves that.

## What `[CONDITIONAL]` actually means

The three conditional sections are earned by **incident-driven need**, not stamped by default. A future role type does NOT inherit them on day one — they're added when the role accrues non-violable rules (outlawed exit shapes, load-bearing skill-file gates, mechanical activity routing) that would warrant them.

Decision rule for a new hire:

- Start with the seven `[REQUIRED]` sections only.
- Add `STOP` when one or more decision moments have a known failure mode where skipping a file load ships the wrong action. Cite the incident (or write the retro alongside) when you add it.
- Add `Done means …` when "done" has outlawed exit shapes specific to this role (not just the generic "work complete") OR when the agent has multiple completion paths and one of them is wrong-by-default.
- Add `Trigger map` when a `skills/` tree exists. Without one, the table is empty noise.

For Coder and QA — the two trigger-heavy roles today — all three conditionals are earned through documented incidents (COD-650 / COD-653 / COD-656 / COD-657 / COD-661 / COD-662). The filled stamps in `coder.md` and `qa.md` are the canonical reference for what an earned-out template looks like.

## How to apply this skeleton

1. Copy the markdown block above into the new agent's `AGENTS.md`.
2. Fill in `<Role>` / `<Title>` / `<Company>` and rewrite each `[REQUIRED]` section for the specific role.
3. For each `[CONDITIONAL]` section, decide: has the role earned it? If yes, write it. If no, delete the heading entirely — do not leave an empty section.
4. If the role uses domain lenses (judgment is the deliverable — security review, UX design, performance engineering), add a `Domain lenses` block under `References` and pull a focused 5–10 lens subset from `references/baseline-role-guide.md`. Lenses are optional and earned, not stamped.
5. Run the pre-submit checklist before opening the hire: `references/draft-review-checklist.md`.

## Worked example — fake SecurityEngineer hire from this skeleton

A new SecurityEngineer role would render:

- All seven `[REQUIRED]` sections filled in.
- `STOP` — likely earned (secret-handling, disclosure workflow — cite the incident).
- `Done means …` — likely earned (a "fix" that does not include a regression test is an outlawed exit; advisory work has its own definition of done distinct from code work).
- `Trigger map` — earned only if the role has a `skills/` tree (`disclosure-handling/SKILL.md`, `threat-model/SKILL.md`, etc.).

The seven-universal-only shape is appropriate for narrow-scope hires (release coordinator, dependency auditor, content designer). Trigger-heavy hires earn the conditionals and render all ten sections.

See also: `coder.md` and `qa.md` for the canonical filled-stamp references; `agent-instruction-templates.md` for the index of existing templates and the adjacent-template path.
