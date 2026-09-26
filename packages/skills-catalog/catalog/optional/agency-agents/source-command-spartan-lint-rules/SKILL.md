---
name: "source-command-spartan-lint-rules"
description: "Validate your .spartan/config.yaml and rule files — check format, paths, and completeness"
key: "paperclipai/optional/agency-agents/source-command-spartan-lint-rules"
recommendedForRoles:
  - "generalist"
tags:
  - "agency-agents"
  - "generalist"
  - "source"
  - "command"
  - "spartan"
  - "lint"
  - "rules"
defaultInstall: false
---
# source-command-spartan-lint-rules

Use this skill when the user asks to run the migrated source command `spartan-lint-rules`.

## Command Template

# Lint Rules

You are a **config validator**. You check that `.spartan/config.yaml` and its rule files are valid and ready for the reviewer.

This is a quick check — should finish in seconds. Don't read full file contents, just check existence and basic format.

---

## Step 1: Find config

```bash
ls .spartan/config.yaml 2>/dev/null
```

If the file doesn't exist:

> No config found. Run `/spartan:init-rules` to create one.

Stop here.

---

## Step 2: Validate config format

Read `.spartan/config.yaml` and check:

| Check | What to look for |
|-------|-----------------|
| Valid YAML | No syntax errors, file parses correctly |
| `stack` field | Must exist (e.g., `kotlin-micronaut`, `react-nextjs`, `custom`) |
| `rules` section | Must have at least one group: `shared`, `backend`, or `frontend` |
| `file-types` section | Should map extensions to modes |
| `review-stages` section | Should have at least one stage |
| `extends` + overrides | If `rules-add`, `rules-remove`, or `rules-override` is set, `extends` must also be set |
| No duplicate rule paths | Same path shouldn't appear twice in any group |

---

## Step 3: Validate rule files

For each rule path listed in the config:

1. **Does the file exist?** Check in order:
   - Project root (relative path)
   - `.Codex/` directory
   - `~/.Codex/` (global)
2. **Is it a `.md` file?**
3. **Does it have a `#` title on the first non-empty line?**
4. **Is it non-empty?**
5. **Does it have code examples?** (Look for triple-backtick blocks. Recommended but not required.)

---

## Step 4: Check review stages

- Are all stage names non-empty strings?
- Is at least one stage `enabled: true`?
- Are there duplicate stage names?

---

## Step 5: Check build commands

If `commands.test.backend` or `commands.test.frontend` is set:
- Does it look like a real command? (not empty string, not just whitespace)
- Same check for `commands.build.*` and `commands.lint.*`

Don't run the commands — just check they're not blank if defined.

---

## Step 6: Report

Print the report using this format:

```
Checking .spartan/config.yaml...

Config format:
  ✅ Valid YAML
  ✅ Stack: go-standard
  ✅ Architecture: clean
  ✅ 5 backend rules, 0 frontend rules, 1 shared rule

Rule files:
  ✅ rules/go/ERROR_HANDLING.md — found, valid
  ✅ rules/go/INTERFACES.md — found, valid
  ❌ rules/go/CONCURRENCY.md — file not found (create it or remove from config)
  ⚠️ rules/go/TESTING.md — no code examples (recommended)

Review stages:
  ✅ 7 stages configured, all enabled

Commands:
  ✅ test: go test ./...
  ✅ build: go build ./...
  ✅ lint: golangci-lint run

Result: {N} errors, {M} warnings
```

**If errors exist:**
> Fix the errors above. The reviewer can't read missing rule files.

**If clean:**
> All good. Your rules are ready for `/spartan:build` and `/spartan:review`.

---

## Rules for this command

- **Fast**: This is a lint check. Don't read full rule file contents — just check existence, first line, and look for backtick blocks.
- **Helpful on errors**: For missing files, say "create it or remove from config." Don't just say "not found."
- **No changes**: This command only reports. It doesn't fix anything. Tell the user what to fix.
- **Preamble-tier 2**: Light context. No heavy scanning needed.
