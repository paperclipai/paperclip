---
name: gstack-careful
description: >
  Safety guardrails for destructive commands. Warns before rm -rf, DROP TABLE,
  force-push, git reset --hard, kubectl delete, and similar destructive operations.
  User can override each warning. Use when touching prod, debugging live systems,
  or working in a shared environment. Use when asked to "be careful", "safety mode",
  "prod mode", or "careful mode".
---

# /gstack-careful — Destructive Command Guardrails

Safety mode is now **active**. Every bash command will be checked for destructive patterns before running. If a destructive command is detected, you'll be warned and can choose to proceed or cancel.

## What's protected

| Pattern | Example | Risk |
|---------|---------|------|
| `rm -rf` / `rm -r` / `rm --recursive` | `rm -rf /var/data` | Recursive delete |
| `DROP TABLE` / `DROP DATABASE` | `DROP TABLE users;` | Data loss |
| `TRUNCATE` | `TRUNCATE orders;` | Data loss |
| `git push --force` / `-f` | `git push -f origin main` | History rewrite |
| `git reset --hard` | `git reset --hard HEAD~3` | Uncommitted work loss |
| `git checkout .` / `git restore .` | `git checkout .` | Uncommitted work loss |
| `kubectl delete` | `kubectl delete pod` | Production impact |
| `docker rm -f` / `docker system prune` | `docker system prune -a` | Container/image loss |

## Safe exceptions

These patterns are allowed without warning:
- `rm -rf node_modules` / `.next` / `dist` / `__pycache__` / `.cache` / `build` / `.turbo` / `coverage`

## How it works

Before executing any bash command that matches a destructive pattern, use AskUserQuestion to confirm:

```
DESTRUCTIVE COMMAND DETECTED: <command>
Risk: <risk description>

A) Proceed — I understand the risk
B) Cancel — don't run this command
```

## Important Rules

- **Always warn before destructive commands.** Use AskUserQuestion to get explicit confirmation.
- **Safe exceptions don't need warnings.** Standard build artifact directories are allowed.
- **To deactivate:** Simply stop using careful mode. This is session-scoped.
- **Never auto-proceed on destructive commands.** Always ask for confirmation.
