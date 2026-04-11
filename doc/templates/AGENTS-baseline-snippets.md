# AGENTS Baseline Snippets

Copy/paste these snippets to roll out `org-engineering-baseline` across projects.

## 1) Global baseline (`~/.codex/AGENTS.md`)

```md
## Global Engineering Baseline

Always apply the `org-engineering-baseline` skill for coding tasks, with this precedence:

1. User instructions
2. Repo-local `AGENTS.md`
3. Global baseline

Use the trivial-task fast path for obvious one-line or non-behavioral edits.
```

## 2) Per-repo integration (repo `AGENTS.md`)

```md
## Org Baseline Integration

This repo uses the global `org-engineering-baseline` skill as default behavior.

Repo-specific safety/contract rules in this file are higher priority and must override
baseline behavior when there is any conflict.

Additional repo requirements:
- company and tenant scope boundaries are mandatory
- contract sync across db/shared/server/ui is mandatory
- completion requires repository verification commands
```

## 3) PR Template additions

Add required sections to your PR template:

- Assumptions
- Alternatives/Tradeoffs
- Scope Justification
- Verification Evidence
- Risks

## 4) CI enforcement ideas

- Fail if required PR sections are missing.
- Fail if behavior-changing PRs add no tests.
- Warn on unrelated file edits (scope drift).
