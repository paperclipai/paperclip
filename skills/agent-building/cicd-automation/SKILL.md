---
name: cicd-automation
description: Deterministic quality gates for Claude Code — Stop hook runs tests before every git commit, PreToolUse hook blocks pushes when red, gh CLI pulls CI failure logs directly into context for auto-fix. Use when Claude committed code without running tests, when you need a guardrail that cannot be skipped, or when CI failures need analysis without leaving Claude Code. Triggers on: "claude skipped tests", "committed broken code", "test before commit", "pre-commit hook", "ci failure analysis", "gh run view", "quality gate", "stop hook testing", "ci/cd claude code", "github actions failure", "auto-fix ci", "blocking commit", "run tests before commit", "never commit without tests", "claude never runs tests", "agent shipped broken code", "hook to run tests", "gh run watch", "ci pipeline claude", "failing ci auto-fix", "tests before push", "pre-push guard". NOT for: generating GitHub Actions workflow YAML files, Docker/Kubernetes config, cloud deployment (Vercel, Railway, AWS), performance/load testing infrastructure.
---

# CI/CD Automation

Three deterministic gates that prevent Claude from shipping broken code:

| Gate | Hook Type | What It Stops |
|---|---|---|
| Pre-commit test runner | Stop | Committing with failing tests |
| Pre-push guard | PreToolUse | Pushing when tests are red |
| CI failure auto-fix | gh CLI loop | Broken CI staying broken |

---

## Quick Setup

### 1. Detect and cache the test command

```bash
bash ~/.claude/hooks/detect-test-command.sh
# Writes: .claude/test-command.txt
```

→ Auto-detection logic for 6 runtimes: `references/test-command-discovery.md`

### 2. Wire the Stop hook (pre-commit gate)

```json
{
  "hooks": {
    "Stop": [{
      "matcher": "",
      "hooks": [{"type": "command", "command": "bash ~/.claude/hooks/pre-commit-gate.sh"}]
    }],
    "PreToolUse": [{
      "matcher": "Bash",
      "hooks": [{"type": "command", "command": "bash ~/.claude/hooks/pre-push-guard.sh"}]
    }]
  }
}
```

→ Full hook scripts: `references/pre-commit-stop-hook.md`, `references/pre-push-hook.md`

---

## Why Checklists Fail and Hooks Don't

CLAUDE.md rules and task checklists live inside the reasoning loop — under agentic pace, they get skipped. Hooks execute outside the reasoning loop: Claude physically cannot commit without tests passing.

→ Evidence from GitHub #35042 + failure taxonomy: `references/why-hooks-not-checklists.md`

---

## Test Command Discovery

Scans project root in order: `package.json` → `bun test`/`jest`/`vitest`, `pyproject.toml` → `pytest`, `Cargo.toml` → `cargo test`, `go.mod` → `go test ./...`, `mix.exs` → `mix test`, `Makefile` → `make test`. Result cached in `.claude/test-command.txt`.

→ Full detection script + override instructions: `references/test-command-discovery.md`

---

## Pre-commit Stop Hook

→ Full hook script + settings.json registration + failure output format: `references/pre-commit-stop-hook.md`

---

## Pre-push PreToolUse Hook

→ Full hook script + push detection pattern + last-exit-code optimization: `references/pre-push-hook.md`

---

## CI Failure Analysis Loop

```bash
gh run list --limit 1                          # Get latest run ID
gh run watch <run-id>                          # Wait for completion
gh run view <run-id> --log-failed              # Pull failure log into context
```

→ Full loop pattern + escalation rule (max 3 auto-fix attempts): `references/ci-failure-loop.md`

---

## PR Gate Integration

```bash
gh pr checks <pr-number> --watch
```

Exits non-zero if any check fails — wire as a required merge step.

→ Integration with structured-project-workflow (#008) + merge block pattern: `references/pr-gate.md`

---

## CLAUDE.md Configuration

```
## Quality Gates (NON-NEGOTIABLE)
- Never run `git commit` directly — the Stop hook runs tests first. If tests fail, fix them.
- Never run `git push` if tests are red — the PreToolUse hook will block it anyway.
- After a push, run `gh run watch` to monitor CI. Do not mark a task done until CI is green.
- If CI auto-fix fails after 3 attempts, write a blocked comment and stop.
```

→ Full CLAUDE.md template + escalation rules: `references/claude-md-config.md`

---

## Anti-Rationalization

| What you'll tell yourself | The truth |
|---|---|
| "The change was small — tests aren't needed" | The hook doesn't know what's small. Neither do you. Small changes break things. |
| "The tests take too long — I'll skip just this once" | Configure a fast subset. Don't disable the gate. One broken commit = hours of debugging. |
| "CI will catch it" | CI catches it after the push. The Stop hook catches it before. Pre-commit is always cheaper. |
| "I'll fix the CI failure manually later" | Later never comes. Wire the auto-fix loop now and it runs itself. |

---

## Reference Index

| File | Contents |
|---|---|
| `references/why-hooks-not-checklists.md` | GitHub #35042 evidence, failure taxonomy, philosophy |
| `references/test-command-discovery.md` | Detection script, 6-runtime priority order, cache format, override |
| `references/pre-commit-stop-hook.md` | Stop hook script, settings.json registration, failure output format |
| `references/pre-push-hook.md` | PreToolUse hook script, push detection pattern, last-exit optimization |
| `references/ci-failure-loop.md` | gh run commands, auto-fix loop pattern, 3-attempt escalation rule |
| `references/pr-gate.md` | gh pr checks integration, spec loop wiring, merge block pattern |
| `references/claude-md-config.md` | CLAUDE.md template, escalation rules, override documentation |
