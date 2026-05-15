# Repo Hygiene Audit — /opt/paperclip

**Generated:** 2026-05-14T23:14:01Z
**Branch:** clean-deepseek-switch
**Commit:** `70e2914d8e1d776bf3f7eb20562d7e6a955aee5f`

---

## Summary

| Category | Count |
|----------|-------|
| Total dirty files | 13 |
| Staged | 0 |
| Unstaged modified | 2 |
| Deleted | 0 |
| Renamed | 0 |
| Untracked | 11 |

## Change Breakdown

### Staged (0)
_None._

### Unstaged Modified (2)
- Source code: 2
- Docs: 0
- Config: 0
- Lockfiles: 0
- Migrations: 0
- Other: 0

### Untracked (11)
- Scripts: 1
- Source code: 2
- Docs: 1
- Env/secrets: 2
- Generated/build: 0
- Runtime artifacts: 0
- Migrations: 0
- Other: 5

---

## Detailed Status

```
 M scripts/telegram-exec-alert/index.ts
 M server/src/routes/issues.ts
?? $AGENT_HOME/
?? .env.github
?? .issues/
?? docs/audit-cre-453-christie-telegram-alerts.md
?? packages/crewbrief-app/
?? reports/
?? scripts/repo-hygiene/
?? scripts/telegram-exec-alert/.env.telegram-alerts
?? server/src/__tests__/issue-english-enforcement.test.ts
?? server/src/services/issue-english-enforcement.ts
?? supabase/
```

---

## Flagged Items

**Untracked scripts** (1):
  - `scripts/repo-hygiene/`
**Possible secrets or env files** (2):
  - `.env.github`
  - `scripts/telegram-exec-alert/.env.telegram-alerts`
**Broad cross-system changes** — touches 8 top-level directories: reports, server, docs, .issues, supabase, $AGENT_HOME, scripts, packages

---

## Assessment

**State:** ⚠️ **Review needed** — possible secrets or env files present

_Audit performed by `scripts/repo-hygiene/nightly-repo-hygiene.sh`. No files were modified._
