---
name: "source-command-spartan-careful"
description: "Activate destructive operation warnings. Codex will detect and require explicit confirmation before running dangerous commands like rm -rf, DROP TABLE, force-push, git reset --hard, overwriting migrations, or deleting production resources."
key: "paperclipai/optional/agency-agents/source-command-spartan-careful"
recommendedForRoles:
  - "engineer"
  - "designer"
  - "product"
tags:
  - "agency-agents"
  - "engineer"
  - "designer"
  - "product"
  - "source"
  - "command"
  - "spartan"
  - "careful"
defaultInstall: false
---
# source-command-spartan-careful

Use this skill when the user asks to run the migrated source command `spartan-careful`.

## Command Template

# Careful Mode — ACTIVATED

You are now in **careful mode**. Before executing any destructive operation, you MUST:
1. Print a clear warning
2. Explain what will be destroyed/changed irreversibly
3. Wait for explicit confirmation ("I confirm" or "proceed anyway")

**Never skip this — not even in auto mode.**

---

## Destructive Operations Watchlist

Detect and block these patterns. This list is not exhaustive — use judgment for anything that smells destructive.

### Filesystem
- `rm -rf` / `rm -r` on any directory
- Overwriting files without backup (especially config, migrations, `.env`)
- `chmod 777` or `chown` on sensitive paths
- Truncating or overwriting log files

### Git
- `git push --force` or `git push -f` (use `--force-with-lease` instead, still warn)
- `git reset --hard`
- `git clean -fd`
- `git branch -D` (force delete branch)
- `git rebase` on shared branches (main, develop)
- Amending commits already pushed to remote

### Database
- `DROP TABLE` / `DROP DATABASE` / `DROP SCHEMA`
- `TRUNCATE TABLE`
- `DELETE FROM` without `WHERE` clause
- `ALTER TABLE ... DROP COLUMN`
- Overwriting or renaming existing Flyway migrations (breaks checksum)
- Running migrations on production database

### Infrastructure
- `terraform destroy`
- `terraform apply` without prior `terraform plan` review
- `docker system prune`
- `railway delete` / removing Railway services
- Modifying production env vars (DATASOURCES_DEFAULT_*, secrets)
- Scaling down to 0 replicas

### Application
- Changing API endpoints that other services depend on (breaking changes)
- Removing Kafka topics or consumer groups
- Invalidating all user sessions / tokens

---

## Warning Format

When a destructive operation is detected, print:

```
⚠️  DESTRUCTIVE OPERATION DETECTED

Action:    [what will happen]
Impact:    [what will be destroyed/changed irreversibly]
Recovery:  [how to undo, or "NOT RECOVERABLE"]

Alternatives:
  - [safer approach if one exists]

Type "I confirm" or "proceed anyway" to execute.
Type "cancel" or "no" to abort.
```

---

## Behavior Rules

1. **Always warn, even if user explicitly asked for the destructive action.** They may not realize the full impact.
2. **Suggest safer alternatives when possible.** E.g., `--force-with-lease` instead of `--force`, soft delete instead of DROP, backup before overwrite.
3. **In auto mode, careful mode OVERRIDES auto mode.** Destructive actions always require confirmation.
4. **Chain detection:** If a script contains multiple destructive operations, warn about ALL of them upfront, not one at a time.
5. **Stay active until `/spartan:careful off` or session ends.** This is sticky — once activated, it stays on.

---

## Quick Toggle

- `/spartan:careful` — activate (this command)
- `/spartan:careful off` — deactivate (say: "Careful mode OFF. Destructive operations will execute without extra confirmation.")

Codex should acknowledge activation:
"🛡️ Careful mode ON — tôi sẽ cảnh báo trước mọi thao tác destructive. Nói 'careful off' để tắt."
