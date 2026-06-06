---
name: bugfix
description: Autonomous test-driven bug fixing with iterative fix-verify loops
---

# Autonomous Bug-Fixing Pipeline

Analyze error → hypothesize root cause → implement minimal fix → verify → repeat until tests pass. Max 5 iterations.

## Input

Provide ONE of:
1. GitHub issue number or URL
2. Error log / stack trace (paste directly)
3. Failing test command: e.g., `pnpm test server/tests/tasks.test.ts`

## Loop (repeat until tests pass, max 5 iterations)

### Step 1: Run Tests & Capture Failure

```bash
pnpm test 2>&1 | tee /tmp/test_output.txt
# Or targeted:
pnpm test server/tests/relevant.test.ts 2>&1 | tee /tmp/test_output.txt
# Type errors:
pnpm -r typecheck 2>&1 | tee /tmp/typecheck_output.txt
```

### Step 2: Form Hypothesis

```
Iteration N Hypothesis:
[1-2 sentence description of root cause]
Root cause: <file>:<line>
Expected fix: <what needs to change>
```

### Step 3: Investigate

```bash
# Read the file from the stack trace
# Search for related code
grep -r "functionName" server/src/
# Check recent changes
git log --oneline -10 -- path/to/file.ts
```

### Step 4: Implement Minimal Fix

Make the **smallest possible change**. No refactoring, no extra features, no unrelated changes.

Preserve contracts across all layers per AGENTS.md:
- `packages/db` schema
- `packages/shared` types
- `server` routes/services
- `ui` API clients

### Step 5: Verify

```bash
pnpm test 2>&1 | tee /tmp/test_output.txt
```

- **PASS** → commit and report
- **FAIL same error** → new hypothesis, loop
- **FAIL different error** → fixed original, form new hypothesis, loop

### Step 6: Commit (when passing)

```bash
git add <files-changed>
git commit -m "fix(scope): <concise description>"
git log -1 --stat
```

## Success Report

```
Fixed in N iterations.
Root Cause: [1-2 sentences]
Fix: [1-2 sentences]
Files Changed: [list]
Tests: all passing
```

## Failure Report (5 iterations exhausted)

```
Could not fix automatically after 5 iterations.
Current error: [what remains]
Hypotheses tried: [numbered list]
Files to investigate: [list with line numbers]
Recommended next step: [why manual investigation is needed]
```

## Guardrails

- Noticed a related bug? File a separate issue — do NOT fix it here.
- Fix needs architectural change? STOP at iteration 2, ask user.
- Tests are flaky? STOP at iteration 1, report.
- Multiple unrelated failures? Fix the FIRST one only.
