---
Owner: Server + Platform
Last Verified: 2026-03-11
Applies To: paperclip monorepo
Links: [DEVELOPING](DEVELOPING.md), [HARNESS_SCORECARD](HARNESS_SCORECARD.md)
---

# Harness Runbook

How to run, reproduce, and interpret harness results locally and in CI.

## Running the Harness Locally

### Quick run (any command)

```sh
pnpm harness:run -- pnpm test:run
```

### With artifact collection

```sh
pnpm harness:run -- --collect-artifacts -- pnpm test:run
```

### What happens

1. A run ID is generated (`YYYYMMDD-HHMMSS-<sha>`)
2. Command runs with stdout/stderr captured to `.harness-artifacts/<run-id>/`
3. Metadata is recorded: git SHA, branch, timestamps, node version
4. Exit code and success/failure are recorded in `result.json`
5. If `--collect-artifacts` is set, e2e results and git state are also collected

### Output structure

```
.harness-artifacts/<run-id>/
  metadata.json       # Run context (sha, branch, command, timestamps)
  result.json         # Exit code, success boolean, finish time
  stdout.log          # Captured stdout
  stderr.log          # Captured stderr
  git-status.txt      # Git working tree status (if artifacts collected)
  git-diff-stat.txt   # Git diff summary (if artifacts collected)
  e2e-test-results/   # Playwright results (if present and collected)
  playwright-report/  # Playwright HTML report (if present and collected)
```

## Reproducing CI Failures

1. Check the failing CI run for the uploaded artifact bundle
2. Download the artifact (named `pr-verify-<sha>` or `e2e-artifacts-<sha>`)
3. Look at `result.json` for exit code, `stderr.log` for error output
4. Reproduce locally:

```sh
git checkout <sha>
pnpm install
pnpm harness:run -- <failing-command>
```

## Classifying Failures

| Category | Symptoms | Action |
|----------|----------|--------|
| **Code bug** | Test assertion fails, typecheck error, build error | Fix the code |
| **Harness bug** | Harness script crashes, metadata missing | Fix harness scripts |
| **Infra flake** | Timeout, network error, transient CI failure | Re-run CI; if persistent, investigate infra |
| **Config drift** | Works locally but not in CI (or vice versa) | Compare node/pnpm versions, env vars |

## CI Artifact Naming

| Workflow | Artifact Name | Trigger |
|----------|--------------|---------|
| PR Verify | `pr-verify-<sha>` | On failure |
| E2E Tests | `e2e-artifacts-<sha>` | Always |
