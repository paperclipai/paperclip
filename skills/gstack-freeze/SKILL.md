---
name: gstack-freeze
description: >
  Restrict file edits to a specific directory for the session. Blocks Edit and
  Write outside the allowed path. Use when debugging to prevent accidentally
  "fixing" unrelated code, or when you want to scope changes to one module.
  Use when asked to "freeze", "restrict edits", "only edit this folder",
  or "lock down edits".
---

# /gstack-freeze — Restrict Edits to a Directory

Lock file edits to a specific directory. Any Edit or Write operation targeting a file outside the allowed path will be **blocked** (not just warned).

## Setup

Ask the user which directory to restrict edits to. Use AskUserQuestion:

- Question: "Which directory should I restrict edits to? Files outside this path will be blocked from editing."
- Text input (not multiple choice) — the user types a path.

Once the user provides a directory path:

1. Resolve it to an absolute path:
```bash
FREEZE_DIR=$(cd "<user-provided-path>" 2>/dev/null && pwd)
echo "$FREEZE_DIR"
```

2. Store the freeze boundary in session memory and inform the user:

Tell the user: "Edits are now restricted to `<path>/`. Any Edit or Write outside this directory will be blocked. To change the boundary, run `/gstack-freeze` again. To remove it, run `/gstack-unfreeze`."

## Enforcement

For every Edit or Write operation:

1. Check if the `file_path` starts with the freeze directory
2. If NOT within the freeze boundary:
   - **Block the operation** with AskUserQuestion:
   ```
   FREEZE BOUNDARY VIOLATION

   You asked me to edit: <file_path>
   Freeze boundary is set to: <freeze_dir>

   This file is outside the allowed directory.

   A) Cancel — don't edit this file
   B) Unfreeze — remove the boundary and proceed
   C) Change boundary — set a new allowed directory
   ```

## Notes

- The trailing `/` on the freeze directory prevents `/src` from matching `/src-old`
- Freeze applies to Edit and Write tools only — Read, Bash, Glob, Grep are unaffected
- This prevents accidental edits, not a security boundary — Bash commands like `sed` can still modify files outside the boundary
- To deactivate, run `/gstack-unfreeze` or end the conversation
