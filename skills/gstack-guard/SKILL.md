---
name: gstack-guard
description: >
  Full safety mode combining /gstack-careful and /gstack-freeze. Warns on
  destructive commands AND restricts edits to a specified directory.
  Use when asked to "guard", "full safety", "protect this area",
  or "maximum caution".
---

# /gstack-guard — Full Safety Mode

Combines `/gstack-careful` and `/gstack-freeze` into a single safety mode. This enables:

1. **Destructive command warnings** — checks all bash commands for dangerous patterns
2. **Edit boundary restriction** — blocks edits outside a specified directory

## Setup

Ask the user for the edit boundary using AskUserQuestion:

- Question: "Which directory should I protect? Edits will be restricted to this path, and I'll warn before any destructive commands."
- Text input (not multiple choice) — the user types a path.

Once the user provides a directory path:

1. Store the guard boundary
2. Inform the user: "Guard mode active. Edits restricted to `<path>/` and destructive commands will require confirmation. Run `/gstack-unfreeze` to remove restrictions."

## Enforcement

Apply both `/gstack-careful` and `/gstack-freeze` rules:

### Destructive Command Protection

Before any bash command matching destructive patterns (rm -rf, DROP TABLE, git push --force, etc.), use AskUserQuestion to confirm.

### Edit Boundary

Before any Edit or Write outside the guard directory, block with AskUserQuestion.

## Safe Exceptions

- Build artifact directories don't need destructive warnings: `node_modules`, `dist`, `.next`, `__pycache__`, `.cache`, `build`, `.turbo`, `coverage`

## Notes

- To remove only the edit restriction: run `/gstack-unfreeze`
- To remove all safety: end the conversation or manually disable both modes
- Guard is session-scoped
