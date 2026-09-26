---
name: "migrate-to-skills"
description: "Convert 'Applied intelligently' Codex rules (.cursor/rules/*.mdc) and slash commands (.cursor/commands/*.md) to Agent Skills format (.cursor/skills/). Use when you want to migrate rules or commands to skills, convert .mdc rules to SKILL.md format, or consolidate commands into the skills directory."
disable-model-invocation: true
key: "paperclipai/optional/agency-agents/migrate-to-skills"
recommendedForRoles:
  - "engineer"
tags:
  - "agency-agents"
  - "engineer"
  - "migrate"
  - "skills"
defaultInstall: false
---
# Migrate Rules and Slash Commands to Skills

Convert Codex rules ("Applied intelligently") and slash commands to Agent Skills format.

**CRITICAL: Preserve the exact body content. Do not modify, reformat, or "improve" it - copy verbatim.**

## Locations

| Level | Source | Destination |
|-------|--------|-------------|
| Project | `{workspaceFolder}/**/.cursor/rules/*.mdc`, `{workspaceFolder}/.cursor/commands/*.md` |
| User | `~/.cursor/commands/*.md` |

Notes:
- Codex rules inside the project can live in nested directories. Be thorough in your search and use glob patterns to find them.
- Ignore anything in ~/.cursor/worktrees
- Ignore anything in ~/.cursor/skills-cursor. This is reserved for Codex's internal built-in skills and is managed automatically by the system.

## Finding Files to Migrate

**Rules**: Migrate if rule has a `description` but NO `globs` and NO `alwaysApply: true`.

**Commands**: Migrate all - they're plain markdown without frontmatter.

## Conversion Format

### Rules: .mdc → SKILL.md

```markdown
# Before: .cursor/rules/my-rule.mdc
---
description: What this rule does
globs:
alwaysApply: false
---
# Title
Body content...
```

```markdown
# After: .cursor/skills/my-rule/SKILL.md
---
name: my-rule
description: What this rule does
---
# Title
Body content...
```

Changes: Add `name` field, remove `globs`/`alwaysApply`, keep body exactly.

### Commands: .md → SKILL.md

```markdown
# Before: .cursor/commands/commit.md
# Commit current work
Instructions here...
```

```markdown
# After: .cursor/skills/commit/SKILL.md
---
name: commit
description: Commit current work with standardized message format
disable-model-invocation: true
---
# Commit current work
Instructions here...
```

Changes: Add frontmatter with `name` (from filename), `description` (infer from content), and `disable-model-invocation: true`, keep body exactly.

**Note:** The `disable-model-invocation: true` field prevents the model from automatically invoking this skill. Slash commands are designed to be explicitly triggered by the user via the `/` menu, not automatically suggested by the model.

## Notes

- `name` must be lowercase with hyphens only
- `description` is critical for skill discovery
- Optionally delete originals after verifying migration works

### Migrate a Rule (.mdc → SKILL.md)

1. Read the rule file
2. Extract the `description` from the frontmatter
3. Extract the body content (everything after the closing `---` of the frontmatter)
4. Create the skill directory: `.cursor/skills/{skill-name}/` (skill name = filename without .mdc)
5. Write `SKILL.md` with new frontmatter (`name` and `description`) + the EXACT original body content (preserve all whitespace, formatting, code blocks verbatim)
6. Delete the original rule file

### Migrate a Command (.md → SKILL.md)

1. Read the command file
2. Extract description from the first heading (remove `#` prefix)
3. Create the skill directory: `.cursor/skills/{skill-name}/` (skill name = filename without .md)
4. Write `SKILL.md` with new frontmatter (`name`, `description`, and `disable-model-invocation: true`) + blank line + the EXACT original file content (preserve all whitespace, formatting, code blocks verbatim)
5. Delete the original command file

**CRITICAL: Copy the body content character-for-character. Do not reformat, fix typos, or "improve" anything.**

## Workflow

If you have the Task tool available:
DO NOT start to read all of the files yourself. That function should be delegated to the subagents. Your job is to dispatch the subagents for each category of files and wait for the results.

1. [ ] Create the skills directories if they don't exist (`.cursor/skills/` for project, `~/.cursor/skills/` for user)
2. Dispatch three fast general purpose subagents (NOT explore) in parallel to do the following steps for project rules (pattern: `{workspaceFolder}/**/.cursor/rules/*.mdc`), user commands (pattern: `~/.cursor/commands/*.md`), and project commands (pattern: `{workspaceFolder}/**/.cursor/commands/*.md`):
  I. [ ] Find files to migrate in the given pattern
  II. [ ] For rules, check if it's an "applied intelligently" rule (has `description`, no `globs`, no `alwaysApply: true`). Commands are always migrated. DO NOT use the terminal to read files. Use the read tool.
  III. [ ] Make a list of files to migrate. If empty, done.
  IV. [ ] For each file, read it, then write the new skill file preserving the body content EXACTLY. DO NOT use the terminal to write these files. Use the edit tool.
  V. [ ] Delete the original file. DO NOT use the terminal to delete these files. Use the delete tool.
  VI. [ ] Return a list of all the skill files that were migrated along with the original file paths.
3. [ ] Wait for all subagents to complete and summarize the results to the user. IMPORTANT: Make sure to let them know if they want to undo the migration, to ask you to.
4. [ ] If the user asks you to undo the migration, do the opposite of the above steps to restore the original files.


If you don't have the Task tool available:
1. [ ] Create the skills directories if they don't exist (`.cursor/skills/` for project, `~/.cursor/skills/` for user)
2. [ ] Find files to migrate in both project (`.cursor/`) and user (`~/.cursor/`) directories
3. [ ] For rules, check if it's an "applied intelligently" rule (has `description`, no `globs`, no `alwaysApply: true`). Commands are always migrated. DO NOT use the terminal to read files. Use the read tool.
4. [ ] Make a list of files to migrate. If empty, done.
5. [ ] For each file, read it, then write the new skill file preserving the body content EXACTLY. DO NOT use the terminal to write these files. Use the edit tool.
6. [ ] Delete the original file. DO NOT use the terminal to delete these files. Use the delete tool.
7. [ ] Summarize the results to the user. IMPORTANT: Make sure to let them know if they want to undo the migration, to ask you to.
8. [ ] If the user asks you to undo the migration, do the opposite of the above steps to restore the original files.
