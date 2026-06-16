# Pilot A2 — Scope Reviewer Context to Diff

**Branch:** `pilot/b1-dogfood`
**Commit:** `37ea5bcb`
**Scope:** `server/src/onboarding-assets/code-reviewer/AGENTS.md`, `server/src/onboarding-assets/wiring-expert/AGENTS.md`, `server/src/routes/issues.ts`

---

## Problem

HIVA-17 reviewers each burned ~1M tokens on a single pass over a 206-line diff. The cause:
no instruction to scope to the changed code. Both code-reviewer and wiring-expert crawled the
full codebase — reading test suites, service files, utilities — most of which were untouched.

~5,000 tokens per line reviewed is the 1M/206-line ratio. The target is closer to the
actual diff volume (~10-50k tokens for a focused review).

---

## Fix

Two changes:

### 1. Diff-first instruction in AGENTS.md (both reviewer roles)

**Code-reviewer** and **wiring-expert** `onboarding-assets/*/AGENTS.md` now open with a
mandatory "Diff-first scope" step:

```bash
git diff master...HEAD --name-only     # touched files
git diff master...HEAD --stat          # change volume
git diff master...HEAD                 # actual diff
```

Then: read ONLY the touched files. Do not crawl files not in the diff.

For wiring-expert: trace only from entrypoints introduced or modified in the diff.

### 2. `prUrl` in W5b contextSnapshot

When the issue has a `prUrl` (GitHub PR), it's now included in the reviewer's wake
contextSnapshot:

```typescript
...(issue.prUrl ? { prUrl: issue.prUrl } : {}),
```

Reviewers can navigate directly to `<prUrl>/files` for the diff without querying.

---

## Expected impact

- Review pass over a small diff: ~50-200k tokens (vs ~1M baseline)
- Reviewer still has all touched files in context — gate decisions unchanged
- `prUrl`-equipped reviewers skip the git diff step entirely (faster)

---

## AC

- Code-reviewer and wiring-expert AGENTS.md contain diff-first instructions
- W5b contextSnapshot includes `prUrl` when available on the issue
- Gate decisions unchanged (reviewers read the diff + touched files → same findings)

---

## Bug fix — BUG-007: cross-file blind spot for auth/concurrency

The blanket "touched files only" rule missed a structural case: auth guards and
concurrency locks often live in one-hop callers or direct imports of a touched file,
not in the touched file itself. A single-file diff touching a service function can
silently drop an ownership check that only the calling route enforced.

Fix (commit `2a5de007`): added a scoped cross-file exception after step 2:

> For dimension 1 (Auth) and dimension 3 (Concurrency) only: also read the
> immediate callers of any touched exported function, and the files directly
> imported by the touched files. Cap at one hop.

The one-hop cap preserves A2 token discipline; the exception closes the auth/concurrency
gap that the original instruction left open.

---

## Files Changed

| File | Change |
|---|---|
| `server/src/onboarding-assets/code-reviewer/AGENTS.md` | Diff-first scope step 1 in "How you operate" + BUG-007 cross-file exception |
| `server/src/onboarding-assets/wiring-expert/AGENTS.md` | Diff-first trace step 1 in "How you operate in Paperclip" |
| `server/src/routes/issues.ts` | Pass `prUrl` in W5b contextSnapshot (A2) |
