# Wish: Slim down CLI board auth implementation

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `slim-cli-auth` |
| **Date** | 2026-03-17 |
| **Parent** | `cli-board-auth` |

## Summary

The `cli-board-auth` feature shipped correctly but is over-engineered: 356-line CLI file, 780 lines of tests, hand-rolled password prompts, duplicate cookie parsing, copy-pasted error handling. Slim it to ~150 lines of implementation and ~300 lines of tests without changing any behavior.

## Scope

### IN
- Slim `cli/src/commands/client/auth.ts` from 356 → ~150 lines
- Slim test files from ~780 → ~300 lines
- Remove duplicate cookie extraction (two-pass regex → one)
- Replace hand-rolled raw-mode password prompt with `readline` question + muted output (or `@inquirer/password` if already a dep)
- Extract shared error handler pattern instead of copy-pasting try/catch in every command
- Consolidate test fixtures and helpers

### OUT
- No behavior changes — all existing tests must still pass
- No new features
- No changes to DB schema, middleware, or API routes (those are already lean)
- No dependency additions unless already in the monorepo

## Decisions

| Decision | Rationale |
|----------|-----------|
| Delete hand-rolled raw-mode password prompt | 40 lines of manual stdin handling. `readline` with `{ terminal: false }` or a simple lib does the same in 5 lines. |
| Single cookie extraction pass | Two identical regex passes on Set-Cookie is pointless. One `getSetCookie()` fallback to `get("set-cookie")` in 3 lines. |
| Wrap command actions with shared error handler | Every command has identical `try { ... } catch (err) { handleCommandError(err) }`. Extract a `withErrorHandler(fn)` wrapper. |
| Shared test factory for API key tests | Tests repeat the same setup (create app, seed user, create key) — extract into a helper. |

## Success Criteria

- [ ] `cli/src/commands/client/auth.ts` is under 160 lines
- [ ] Total test lines for auth features under 350
- [ ] All existing tests pass: `pnpm test:run`
- [ ] Typecheck passes: `pnpm -r typecheck`
- [ ] No behavior changes — same CLI commands, same API, same output

## Execution Groups

### Group 1: Slim CLI auth commands

**Goal:** Cut `auth.ts` from 356 → ~150 lines.

**Deliverables:**
1. Replace `promptPassword()` (40 lines) with a 5-line version using readline question
2. Merge `promptInput` and `promptPassword` into one `prompt(label, {hidden?})` function
3. Single-pass cookie extraction (delete lines 156-163)
4. Extract `withErrorHandler(fn)` wrapper, use in all 5 commands
5. Inline `resolveApiBase` (it's only used once and duplicates logic already in `resolveCommandContext`)
6. Remove redundant null checks and verbose type annotations

**Acceptance criteria:**
- File under 160 lines
- Same CLI behavior (login, create-key, whoami, list-keys, revoke-key all work identically)

**Validation:**
```bash
cd /home/genie/prod/paperclip && pnpm -r typecheck
```

**depends-on:** none

---

### Group 2: Slim test files

**Goal:** Cut auth test files from ~780 → ~300 lines.

**Deliverables:**
1. Extract shared test helpers (createTestApp, seedUser, createPAT) into `__tests__/helpers/auth-fixtures.ts`
2. Consolidate repetitive assertions
3. Remove verbose inline comments that restate obvious behavior
4. Use `it.each` for parameterized rejection cases (revoked, expired, invalid)

**Acceptance criteria:**
- Total auth test lines under 350
- All tests still pass
- No test coverage reduction (same scenarios covered)

**Validation:**
```bash
cd /home/genie/prod/paperclip && pnpm test:run
```

**depends-on:** Group 1

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Refactor breaks subtle behavior | Low | All existing tests must pass unchanged before we touch them. Run tests after every file change. |
| Password prompt behavior changes on edge-case terminals | Low | Keep readline-based approach, just simplify the wrapper. Don't change stdin handling semantics. |
