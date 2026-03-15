---
name: paperclip-create-skill
description: >
  Create and evolve skills for an agent's own workflow in a lightweight,
  additive way. Use when an agent should codify repeated successful patterns
  into reusable skills, keep prompts lean, and prepare skills for board approval
  before broader publication.
---

# Paperclip Create Skill

Use this skill when you want to convert repeated successful behavior into a reusable skill, especially for the current agent first.

## Why skills (not prompt bloat)

- Keep base agent instructions stable and small.
- Put workflow-specific behavior in modular, discoverable units.
- Improve future runs without inflating AGENTS.md or run prompts.

## Scope model

Start narrow, then expand with governance:

1. **Self scope first** (agent-only workflow hardening)
2. **Candidate for publication** (proposed for broader use)
3. **Board-approved publication** (shared/adopted beyond self)

Do not skip step 1 unless explicitly instructed.

## Skill location and structure

For self-authored skills, create under the agent-accessible skill root used by the runtime (for example `.claude/skills/<skill-name>/SKILL.md` or `.agents/skills/<skill-name>/SKILL.md`, depending on environment conventions).

Minimum structure:

```text
<skill-name>/
  SKILL.md
```

Optional:

```text
<skill-name>/
  SKILL.md
  references.md
  examples.md
  scripts/
```

## Authoring requirements

Every `SKILL.md` must include:

1. Frontmatter:
   - `name`: lowercase letters, numbers, hyphens only
   - `description`: specific WHAT + WHEN trigger terms
2. Clear workflow steps
3. Practical examples
4. Explicit guardrails/failure handling

Keep SKILL content concise and operational. Assume agent baseline competence; include only domain-specific deltas.

## Creation workflow

### Step 1: Identify a repeated pattern

Candidate signal:

- Same task pattern repeated 2+ times
- Manual steps are stable and low-variance
- Outputs have a consistent quality bar

If pattern is one-off or highly ambiguous, do not create a skill.

### Step 2: Define skill contract

Draft:

- Purpose (single main job)
- Trigger conditions (when to auto-apply)
- Inputs expected
- Output format
- Stop conditions / escalation points

### Step 3: Generate SKILL.md

Use this template:

```markdown
---
name: <skill-name>
description: <what it does and when to use it>
---

# <Title>

## Use this when
- <trigger 1>
- <trigger 2>

## Workflow
1. <step>
2. <step>
3. <step>

## Validation
- <check>
- <check>

## Failure handling
- <what to do when blocked>

## Example
<concise example>
```

### Step 4: Self-test

Validate the skill by using it on one realistic task:

- Did it reduce time or errors?
- Did it avoid prompt growth?
- Did output quality improve?

If no measurable improvement, revise or discard.

## Revision policy

When updating a self-skill:

- Prefer additive edits over rewrites.
- Keep terminology consistent.
- Keep examples synced with current workflow.
- Remove stale/time-sensitive guidance.

## Governance: board approval for broader publication

If a self-skill is proposed for company-wide/shared adoption:

1. Prepare a publish candidate summary:
   - problem solved
   - evidence from successful runs/chats
   - risk/rollback notes
2. Submit through the board approval path (same governance bar as other high-impact operational additions).
3. Do not treat as broadly active until approved.

If rejected or revision requested:

- keep private/self scope
- apply board feedback
- resubmit only when evidence and safety concerns are addressed

## Guardrails

- Never put secrets or tokens in skill files.
- Never encode destructive commands as default behavior.
- Never create giant monolithic skills; split by workflow boundary.
- Never replace core Paperclip governance with ad-hoc rules in a skill.

## Definition of done

A self-authored skill is done when:

- it is concise and discoverable,
- it improves repeated task execution,
- it does not bloat base prompts,
- and it has a clear path for board-approved publication when needed.
