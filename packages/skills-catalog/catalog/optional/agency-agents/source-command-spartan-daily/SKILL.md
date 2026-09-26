---
name: "source-command-spartan-daily"
description: "Generate a daily standup summary based on recent git history"
key: "paperclipai/optional/agency-agents/source-command-spartan-daily"
recommendedForRoles:
  - "generalist"
tags:
  - "agency-agents"
  - "generalist"
  - "source"
  - "command"
  - "spartan"
  - "daily"
defaultInstall: false
---
# source-command-spartan-daily

Use this skill when the user asks to run the migrated source command `spartan-daily`.

## Command Template

Generate a daily engineering standup summary for the current project.

## Steps

1. **Check recent git history** (last 24-48h):
   ```bash
   git log --since="2 days ago" --oneline --author="$(git config user.name)"
   ```

2. **Check active specs/plans** (if `.planning/` exists):
   Read `.planning/specs/` and `.planning/plans/` for in-flight work.

3. **Check for any failing tests or CI notes** (if available):
   Look for recent test output files or CI logs.

## Output Format

```markdown
## Daily Standup — [DATE]

### Yesterday / Done
- [completed items from git log]

### Today / In Progress
- [current active task]
- [next planned task]

### Blockers
- [any blockers found, or "None"]
```

Keep it concise — each section max 3-4 bullet points.
This is for a 15-minute standup, not a status report.
