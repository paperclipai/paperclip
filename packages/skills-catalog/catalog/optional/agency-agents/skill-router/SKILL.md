---
name: "skill-router"
description: "Use this skill whenever more than one installed skill could plausibly apply to the current task, when it's unclear which skill (if any) fits best, when a task spans multiple domains and may need two or more skills chained together in sequence, or when you want an explicit, auditable record of..."
key: "paperclipai/optional/agency-agents/skill-router"
recommendedForRoles:
  - "generalist"
tags:
  - "agency-agents"
  - "generalist"
  - "skill"
  - "router"
defaultInstall: false
---
# Skill Router

Most of the time you don't need this. Codex already scans every installed
skill's `name` + `description` and consults the one that matches — that's
the default mechanism, and it works fine for the common case of one clear
skill, one clear task.

This skill exists for the cases the default mechanism handles poorly:

- Two or more skills' descriptions could plausibly cover the same request
- The task has multiple stages that span different skills' territory
- You genuinely can't tell from the description whether a skill applies
- You want a visible trail of *why* a skill was picked, for later review
- Nothing available actually fits, and silently guessing would be worse
  than saying so

If none of those are true, skip this skill and just proceed normally.

## Process

**1. Enumerate candidates**
List every currently available skill (name + one-line description). Don't
rely on memory of what's "usually" installed — check what's actually
present right now, since that set can change between sessions or between
floors/projects.

**2. Score fit against the actual task**
For each candidate, ask: does this skill's stated scope cover what the
task needs, or only something adjacent to it? A skill for "spreadsheets"
is not automatically a fit for "extract this table from a PDF" — that's
pdf-reading's job even though the output ends up tabular. Match on what
the skill is *for*, not on surface keyword overlap.

**3. Decide: single, chain, or none**
- **Single** — one skill clearly covers the whole task. Use it, done.
- **Chain** — the task has stages that fall to different skills (e.g.
  "extract data from this PDF, build a chart from it, and put it in a
  slide deck" → pdf-reading → xlsx/data-analysis → pptx). Run them in the
  order the task actually requires, feeding each stage's output into the
  next. State the chain explicitly before executing it so a reviewer (or
  the user) can see the plan, not just the result.
- **None** — nothing available actually fits. Say so plainly, proceed
  with general-purpose tools, and don't force a skill to apply just
  because it's the closest thing on the shelf. If this kind of task is
  likely to recur, flag that a new skill could be worth creating (that's
  what skill-creator is for) rather than quietly improvising every time.

**4. Break ties by specificity, not recency or order**
When two skills genuinely overlap, prefer the one scoped tighter to the
exact input or output at hand (e.g. a "docx" skill beats a generic
"file-reading" skill for editing a Word doc, even though both could
technically touch the file). If they're truly tied and the choice matters
for the outcome — not just a stylistic preference — ask rather than pick
arbitrarily. Don't ask for trivial or low-stakes ties.

**5. Record the decision**
Keep a short, plain trail of what was considered and why, e.g.:

```
Task: <one line>
Considered: <skill A>, <skill B>
Chose: <skill(s)>, <chain order if applicable>
Why: <one line — what made this the fit, or why nothing fit>
```

If this is running inside a system that keeps its own memory per project
or agent, that log is exactly the kind of thing worth appending there —
it's what lets a recurring pattern ("this type of request always needs A
then B") get short-circuited next time instead of re-derived from
scratch.

## Anti-patterns to avoid

- **Don't** invoke this skill for a one-skill, one-step task — that's
  overhead the default mechanism already handles.
- **Don't** silently pick a skill that's "close enough" when nothing
  actually fits — say nothing fits and proceed without one.
- **Don't** run a chain in convenience order — run it in the order the
  task's own stages require, even if that means loading a less-obvious
  skill first.
- **Don't** treat this as a excuse to second-guess an obvious match —
  if a skill's description is a clean fit, use it and move on.
