---
name: code-review
description: Comprehensive code review with quality gates. Covers type safety, error handling, state coverage, security, tests, and edge cases. Includes PR review workflow.
---

# Code Review

Systematic code review protocol that catches issues across all layers. Not just "does it work?" but "does it work in every state, at every scale, for every user?"

## When To Use

- Before merging any PR
- After a sub-agent completes a build
- When reviewing code you wrote yourself (pattern blindness defense: spawn a specialist)
- Before deploying to production
- When inheriting or onboarding to a codebase

## The Review Checklist

### 1. Type Safety

- [ ] TypeScript strict mode enabled (no `// @ts-ignore` or `// @ts-expect-error` without justification)
- [ ] No `any` types (use `unknown` + type guards instead)
- [ ] Function signatures have explicit return types for public APIs
- [ ] Generic types are constrained (not `<T>` but `<T extends BaseType>`)
- [ ] Union types are handled exhaustively (switch statements have default that throws)
- [ ] Null/undefined handled explicitly (no optional chaining hiding bugs)

### 2. Error Handling

- [ ] Every `async` operation wrapped in try/catch or `.catch()`
- [ ] Errors are typed or checked before being used (not `catch(e) { return e.message }`)
- [ ] User-facing error messages are helpful (not stack traces or "Something went wrong")
- [ ] Errors propagate correctly (not swallowed silently)
- [ ] API responses have consistent error shape
- [ ] Retry logic exists for transient failures (network, rate limits)
- [ ] Timeout handling for external calls

### 3. State Coverage

For every component that depends on data:

- [ ] **Loading state:** Skeleton, spinner, or disabled UI while data loads
- [ ] **Empty state:** Meaningful message when no data exists (not blank screen)
- [ ] **Error state:** Error message with retry option
- [ ] **Partial state:** What happens with incomplete data?
- [ ] **Stale state:** How does the UI handle outdated data?

### 4. Security

- [ ] No secrets in client-side code (API keys, tokens, passwords)
- [ ] Input sanitized before database queries (parameterized queries, not string interpolation)
- [ ] Auth checked at the API layer (not just the UI layer)
- [ ] Rate limiting on sensitive endpoints (login, payment, API keys)
- [ ] CORS configured correctly (not `*` in production)
- [ ] Sensitive data not logged (passwords, tokens, PII)
- [ ] File uploads validated (type, size, content)
- [ ] No SQL injection vectors (raw queries with user input)
- [ ] No XSS vectors (unsanitized HTML rendering)

### 5. Tests

- [ ] Unit tests exist for business logic
- [ ] Tests cover happy path AND error paths
- [ ] Tests are deterministic (no timing-dependent assertions)
- [ ] Test names describe behavior, not implementation ("should reject expired tokens" not "test auth middleware")
- [ ] Mocks are minimal (mock external services, not internal logic)
- [ ] All tests pass: `npm test` exits 0

### 6. Build

- [ ] `npm run build` passes with zero errors
- [ ] No new warnings introduced (or warnings are justified)
- [ ] Bundle size has not increased unexpectedly
- [ ] No unused imports or dead code

### 7. Edge Cases

- [ ] **Zero items:** Does the UI handle an empty list?
- [ ] **One item:** Does layout work with a single entry?
- [ ] **Many items:** Does it paginate/virtualize for 10,000+ items?
- [ ] **Null/undefined:** What happens when optional fields are missing?
- [ ] **Concurrent access:** What happens if two users edit the same resource?
- [ ] **Network failure:** What happens mid-operation?
- [ ] **Browser back button:** Does navigation state survive?

### 8. Responsive & Accessibility

- [ ] Mobile layout works at 375px width
- [ ] Tablet layout works at 768px
- [ ] Wide screen does not stretch content to unreadable widths
- [ ] Touch targets are at least 44x44px on mobile
- [ ] Keyboard navigation works (tab order, focus management)
- [ ] Screen reader can parse the page (semantic HTML, aria labels)
- [ ] Color contrast meets WCAG AA (4.5:1 for text)
- [ ] Dark mode renders correctly

## PR Review Workflow

### Reading the Diff

1. Read the PR description first. Understand intent before code.
2. Start with schema/migration files. Data model changes affect everything above.
3. Read API changes next. Contract changes affect all consumers.
4. Read component/UI changes last. These should follow from the layers below.
5. Check test changes. Do they actually test the new behavior?

### Writing Review Comments

**Be specific.** Not "this could be better" but "this catches `Error` but the payment API throws `PaymentError` with a `code` field. Catch `PaymentError` and surface `error.code` to the user."

**Categorize severity:**
- **BLOCKER:** Must fix before merge. Security issue, data loss risk, broken functionality.
- **IMPORTANT:** Should fix before merge. Missing error handling, untested path, accessibility gap.
- **NIT:** Can fix later. Style preference, naming suggestion, minor optimization.
- **QUESTION:** Not a suggestion, just need to understand the reasoning.

**Praise good work.** A review that only finds problems trains people to dread reviews.

### Self-Review Defense

When reviewing your own code, you will miss things. Pattern blindness is real. Mitigate by:

1. Wait at least 30 minutes between writing and reviewing (if possible)
2. Read the diff as if someone else wrote it
3. Spawn a specialist sub-agent with a hostile review prompt
4. Focus on what you were NOT thinking about while writing (error paths, edge cases, security)

## Quality Gate

Before approving any code:
- [ ] All 8 checklist sections evaluated
- [ ] Blockers have zero unresolved items
- [ ] Build passes
- [ ] Tests pass
- [ ] At least one end-to-end user flow traced through the changes
