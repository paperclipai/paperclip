# Step 2: User Customization Layer

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this task.

## Quick Reference
- **Branch:** `feat/pai-patterns-02-customization`
- **Complexity:** S
- **Dependencies:** None
- **Estimated files:** 4-5

## Objective
Create a convention where users can override skill defaults via a customization directory that survives skill updates. Define the directory structure, the check-and-load pattern skills use, and document it for skill authors.

## Context from Research
PAI uses `~/.claude/PAI/USER/SKILLCUSTOMIZATIONS/{SkillName}/` with a PREFERENCES.md and optional structured config files. Skills check for this directory at invocation and merge overrides.

Our adaptation is simpler: freeform PREFERENCES.md (no schema enforcement), global + project-local scoping (matching CLAUDE.md's existing pattern), and no `{PRINCIPAL.NAME}` template variables.

## Prerequisites
- [ ] Understand current skill invocation flow (SKILL.md is loaded by Claude Code skill matching)

## Implementation

**Read these files first** (in parallel):
- `skills/agent-building/highimpact-skill-builder/SKILL.md` — where to document for authors
- `skills/agent-building/highimpact-skill-builder/references/create.md` — creation templates
- `skills/agent-building/context-cost-management/SKILL.md` — candidate for adding customization check

### 1. Define the Convention

Create `docs/conventions/skill-customization.md` documenting:

**Directory structure:**
```
# Global customizations (apply everywhere)
~/.claude/skill-customizations/
├── context-cost-management/
│   └── PREFERENCES.md
└── research/
    ├── PREFERENCES.md
    └── sources.yaml

# Project-local customizations (override global)
.claude/skill-customizations/
└── context-cost-management/
    └── PREFERENCES.md
```

**PREFERENCES.md format:**
```markdown
# Skill Customization: [skill-name]

## Defaults Override
- Always use extensive research mode (never quick)
- Prefer Sonnet over Haiku for all subagent work
- Skip the anti-rationalization table in output

## Additional Context
- Our team uses PostgreSQL, not SQLite
- CI runs on GitHub Actions, not CircleCI
```

No schema. No YAML parsing. The LLM reads it and adjusts behavior accordingly. This is the simplest approach that actually works.

**Merge order:** Project-local > Global > Skill defaults

### 2. Create the Check-and-Load Pattern

Add a standard snippet that skills include at the top of their execution:

```markdown
## Customization

**Before executing, check for user customizations:**
1. Read `{project}/.claude/skill-customizations/{skill-name}/PREFERENCES.md` (if exists)
2. Read `~/.claude/skill-customizations/{skill-name}/PREFERENCES.md` (if exists)
3. Project-local overrides global. Both override skill defaults.
4. If neither exists, proceed with skill defaults.
```

This is a convention — a paragraph that skill authors copy into their SKILL.md. Not a runtime system.

### 3. Update highimpact-skill-builder

Add the customization pattern to the skill creation flow:

- In Phase 1 (Create), after writing SKILL.md: include the customization check block
- In the Skill Writing Guide: add a "User Customization" section explaining the pattern
- In `references/create.md`: add the customization snippet to the SKILL.md template

### 4. Create Example Customization

Create a sample `~/.claude/skill-customizations/example/PREFERENCES.md` showing the format:

```markdown
# Skill Customization: example

This is a template. Copy this directory for any skill you want to customize.

## Defaults Override
- [Your preference overrides here]

## Additional Context
- [Project-specific context the skill should know]
```

## Files to Create/Modify

### Create:
- `docs/conventions/skill-customization.md` — Convention documentation
- `~/.claude/skill-customizations/README.md` — Directory purpose and example

### Modify:
- `skills/agent-building/highimpact-skill-builder/SKILL.md` — Add customization to Skill Writing Guide
- `skills/agent-building/highimpact-skill-builder/references/create.md` — Add customization snippet to template
- `skills/agent-building/context-cost-management/SKILL.md` — Add customization check as proof (after Step 1 refactors it to a router, add the check block)

## Verification

### Automated Checks
```bash
# Verify convention doc exists
test -f docs/conventions/skill-customization.md && echo "PASS" || echo "FAIL"

# Verify customization directory created
test -d ~/.claude/skill-customizations && echo "PASS" || echo "FAIL"

# Verify skill-builder mentions customization
grep -l "skill-customizations" skills/agent-building/highimpact-skill-builder/SKILL.md && echo "PASS" || echo "FAIL"
```

### Manual Verification
- [ ] Convention doc is clear and complete
- [ ] The check-and-load pattern is copy-pasteable for skill authors
- [ ] highimpact-skill-builder includes customization in its creation template
- [ ] Example PREFERENCES.md is self-documenting

## Success Criteria
- [ ] Convention documented with directory structure, format, and merge order
- [ ] Check-and-load snippet defined for skill authors
- [ ] Skill builder updated to include customization support in new skills
- [ ] Example customization directory created at ~/.claude/skill-customizations/

## Scope Boundaries
**Do:** Define the convention, create examples, update skill builder docs
**Don't:** Retrofit all 14 existing skills with customization checks. Don't build a runtime loader. Don't create schema validation.

## Escape Route Closure
- "We should add YAML schema validation for PREFERENCES.md" → No. Freeform markdown is the point. LLMs don't need schemas to understand preferences.
- "Every existing skill should get the customization check now" → No. New skills get it automatically via the builder. Existing skills get it when they're next touched.
- "We need a CLI to manage customizations" → Over-engineering. Users create a directory and write markdown. That's it.
