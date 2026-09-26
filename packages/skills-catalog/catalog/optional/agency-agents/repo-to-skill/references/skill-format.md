# Skill Format Reference

## Required Structure

```
skill-name/
├── SKILL.md          # Required — YAML frontmatter + markdown body
├── references/       # Optional — docs loaded into context as needed
├── scripts/          # Optional — executable code for deterministic tasks
└── assets/           # Optional — files used in output (templates, etc.)
```

## SKILL.md Requirements

### Frontmatter (YAML)
```yaml
---
name: skill-name        # lowercase, hyphens only
description: >          # Primary trigger mechanism — be specific and pushy
  What it does and when to use it. Include trigger phrases.
---
```

### Body Guidelines
- Under 500 lines ideal
- Use imperative form ("Run X", not "You should run X")
- Prefer examples over explanations
- Only include what the model doesn't already know
- Reference files clearly with guidance on when to read them

## Description Best Practices

The description is the PRIMARY trigger. Make it:
- **Specific**: Include exact tool names, commands, file types
- **Pushy**: "Use when... even if they don't explicitly ask for..."
- **Comprehensive**: Cover all trigger scenarios

Example:
```
Control Philips Hue lights via OpenHue CLI. Use when asked about
smart lights, room lighting, light scenes, brightness, color temperature,
or home automation — even if the user doesn't mention "Hue" specifically.
```

## Progressive Disclosure

1. **Metadata** (~100 words) — always in context
2. **SKILL.md body** (<500 lines) — loaded when skill triggers
3. **References** (unlimited) — loaded on demand

## What NOT to Include

- README.md, CHANGELOG.md, INSTALLATION_GUIDE.md
- User-facing documentation
- Setup/testing procedures
- Process documentation about creating the skill
