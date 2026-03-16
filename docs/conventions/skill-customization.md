# Skill Customization Convention

Users can override skill defaults via a customization directory that survives skill updates. Skills check this directory at invocation and adjust behavior accordingly.

## Directory Structure

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

**Merge order:** Project-local > Global > Skill defaults

## PREFERENCES.md Format

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

## Check-and-Load Pattern

Skills include this block near the top of their execution instructions:

```markdown
## Customization

**Before executing, check for user customizations:**
1. Read `{project}/.claude/skill-customizations/{skill-name}/PREFERENCES.md` (if exists)
2. Read `~/.claude/skill-customizations/{skill-name}/PREFERENCES.md` (if exists)
3. Project-local overrides global. Both override skill defaults.
4. If neither exists, proceed with skill defaults.
```

This is a convention — a paragraph that skill authors copy into their SKILL.md. Not a runtime system.

## For Skill Authors

Add the check-and-load block to your SKILL.md after the intro section, before the first workflow step. Use `{skill-name}` matching your skill's directory name (e.g., `context-cost-management`, `tdd-workflow`).

Users who want to customize create the file. Users who don't are unaffected. Zero runtime overhead.

## Scope Boundaries

**Do:** Freeform PREFERENCES.md, global + project-local scoping.

**Don't:** YAML schema validation, CLI tooling, runtime loaders, auto-generating PREFERENCES.md from interviews.

The power is in the simplicity. LLMs understand natural language preferences. Trust that.
