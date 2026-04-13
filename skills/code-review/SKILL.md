---
name: code-review
description: >
  Review code for correctness, security, performance, and style. Trigger on: "review",
  "code review", "review this", "review my code", "review the diff", "review my PR",
  "review changes", "/code-review", "look at my code", "check my code", "audit this".
  Reviews staged changes, a specific file, a diff, or a PR. Returns structured findings
  with severity levels and actionable fix suggestions.
metadata:
  version: "1.0.0"
  author: "Angel Hermon"
roles: [cto, developer]
---

# Code Review Skill

Reviews code for bugs, security issues, performance problems, and style. Works on
the current diff, a file, or a GitHub PR. Returns a structured report with severities.

---

## Telemetry

Emit skill events so code-review usage is queryable in the Paperclip dashboard.

**At skill start:**
```bash
SKILL_START_MS=$(date +%s%3N)
SKILL_SESSION="skill-code-review-$(date +%s)-$$"
python3 "${CLAUDE_CONFIG_DIR:-/paperclip/.agent-hooks}/hooks/skill_telemetry.py" \
  start code-review "$SKILL_SESSION" 2>/dev/null &
```

**At skill end:**
```bash
SKILL_DURATION_MS=$(( $(date +%s%3N) - SKILL_START_MS ))
python3 "${CLAUDE_CONFIG_DIR:-/paperclip/.agent-hooks}/hooks/skill_telemetry.py" \
  end code-review "$SKILL_SESSION" --success true --duration_ms "$SKILL_DURATION_MS" 2>/dev/null &
```

Fails silently — a broken backend never blocks the review.

---

## Step 1: Determine the Review Scope

Parse the user's request:

| Request | Scope |
|---------|-------|
| "review my changes" / no target | `git diff HEAD` (staged + unstaged) |
| "review staged" | `git diff --cached` |
| "review <file>" | Read that file |
| "review PR #N" | Fetch PR diff from GitHub |
| "review this" (with pasted code) | Use pasted content |

If ambiguous, prefer `git diff HEAD` and state the assumption.

---

## Step 2: Collect the Code

**For git diff:**
```bash
git diff HEAD
```
or:
```bash
git diff --cached
```

**For a file:**
Read the file in full.

**For a GitHub PR (if `gh` CLI is available):**
```bash
gh pr diff <number>
gh pr view <number>
```

---

## Step 3: Analyze the Code

Review across these dimensions in order of severity:

### 3a. Security (P0 — always check)

- **Injection**: SQL injection, command injection, template injection, LDAP injection
- **Auth/AuthZ**: Missing authentication, broken authorization, insecure direct object refs
- **Secrets**: Hardcoded API keys, passwords, tokens, private keys in code
- **Input validation**: Missing or insufficient validation of external input
- **XSS**: Unescaped user content rendered in HTML
- **Path traversal**: Unsanitized file paths constructed from user input
- **Dependency vulnerabilities**: Use of known-vulnerable packages (if visible from imports)
- **Insecure defaults**: Debug mode in prod, permissive CORS (`*`), disabled TLS verification

### 3b. Correctness (P1)

- Logic errors — off-by-one, inverted conditions, wrong operator
- Null/undefined dereferences — missing nil checks, optional chaining gaps
- Error handling — swallowed errors, missing error propagation, panic-unsafe code
- Race conditions — unsynchronized shared state, TOCTOU, missing locks
- Resource leaks — unclosed files, DB connections, HTTP clients
- Type mismatches — incorrect type assumptions, implicit coercions
- Edge cases — empty inputs, zero values, boundary conditions unhandled

### 3c. Performance (P2)

- N+1 queries — database calls inside loops
- Missing indexes — queries on unindexed columns (if schema visible)
- Inefficient algorithms — O(n²) where O(n log n) is possible
- Memory leaks — growing data structures, retained closures
- Blocking I/O in async context — sync calls blocking the event loop
- Redundant computation — repeated work that could be cached

### 3d. Maintainability (P3)

- Overly complex functions — hard to read, too many responsibilities
- Magic numbers/strings — unexplained literals (prefer named constants)
- Dead code — unreachable branches, unused variables/imports
- Inconsistent style — naming, formatting deviates from surrounding code
- Missing error messages — errors without context make debugging harder
- Duplicate logic — copy-paste that should be a shared function

---

## Step 4: Write the Review Report

Use this structured format:

```markdown
## Code Review

**Files reviewed:** <list of files or "staged diff">
**Lines changed:** <approximate count>

---

### Findings

#### [P0-SECURITY] <Short title>
**File:** `path/to/file.ts:42`
**Issue:** <What the problem is>
**Risk:** <What an attacker/bug could do>
**Fix:**
\```language
// suggested fix
\```

---

#### [P1-BUG] <Short title>
**File:** `path/to/file.ts:87`
**Issue:** <What is wrong>
**Fix:** <Short description or code snippet>

---

#### [P2-PERF] <Short title>
**File:** `path/to/file.ts:120`
**Issue:** <Performance concern>
**Fix:** <Suggestion>

---

#### [P3-STYLE] <Short title>
**File:** `path/to/file.ts:15`
**Issue:** <Style concern>
**Suggestion:** <How to improve>

---

### Summary

| Severity | Count |
|----------|-------|
| P0 Security | N |
| P1 Bug | N |
| P2 Performance | N |
| P3 Style | N |

**Overall:** <One of: LGTM / Minor issues / Needs work / Blocking issues>

**Must-fix before merge:** <list P0 and P1 issues, or "None">
```

---

## Step 5: Prioritize Feedback

- **P0 (Security)**: Always report. Explain the risk and provide a concrete fix.
- **P1 (Bug)**: Always report. Include a fix.
- **P2 (Performance)**: Report when the issue is likely to matter at scale.
- **P3 (Style)**: Report only the most impactful. Do not nitpick minor style if the code is otherwise good.

If there are no issues, say so clearly:
> No issues found. The code looks correct and well-structured.

---

## Step 6: Optional — Auto-fix

If the user says "review and fix" or "fix the issues":

1. Apply P0 and P1 fixes directly using Edit tool
2. Summarize each fix made
3. Do NOT auto-fix P2/P3 unless explicitly asked
4. Stage the fixes with `git add` if requested

---

## Severity Reference

| Level | Meaning | Action |
|-------|---------|--------|
| P0-SECURITY | Exploitable vulnerability or data exposure | Block merge |
| P1-BUG | Incorrect behavior, data loss, crash risk | Block merge |
| P2-PERF | Performance problem (significant at scale) | Fix before ship |
| P3-STYLE | Readability, maintainability, convention | Nice to have |
| LGTM | No issues found | Approve |
