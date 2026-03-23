# Software Development Life Cycle (SDLC) — QH Company

> QUA-175 | Version 1.0 | 2026-03-22

## Overview

Quy trình phát triển phần mềm chuẩn hóa cho phòng Software Development, áp dụng cho tất cả agents (Software Agent 1-5, QA Tester, UI/UX Designer) dưới sự quản lý của CTO.

## Flow: Intake → Spec → Dev → QA → Release

```
┌─────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│ INTAKE   │───▶│  SPEC    │───▶│   DEV    │───▶│   QA     │───▶│ RELEASE  │
│ (Board/  │    │ (CTO/PM) │    │ (SA1-5)  │    │ (QA)     │    │ (CTO)    │
│  CTO)    │    │          │    │          │    │          │    │          │
└─────────┘    └──────────┘    └──────────┘    └──────────┘    └──────────┘
```

---

## Phase 1: INTAKE

**Owner:** Board / CTO / PM
**Input:** Bug report, feature request, GitHub issue, UX audit finding
**Output:** Paperclip issue (QUA-xxx) with priority and assignee

### Checklist
- [ ] Issue created in Paperclip with clear title
- [ ] Priority set (critical / high / medium / low)
- [ ] Category tagged (bug / feature / a11y / ux / refactor / infra)
- [ ] Assignee designated
- [ ] Related GitHub issue linked (if applicable)
- [ ] Acceptance criteria defined (or delegated to Spec phase)

### Tiêu chí đầu vào
- Mô tả vấn đề rõ ràng hoặc user story
- Priority được CTO hoặc PM xác nhận

### Tiêu chí đầu ra
- Issue status: `todo` hoặc `backlog`
- Có đủ context để developer hiểu và bắt đầu

---

## Phase 2: SPEC

**Owner:** CTO (technical spec) / PM (product spec) / UI/UX Designer (design spec)
**Input:** Paperclip issue từ Intake
**Output:** Implementation plan comment on issue

### Checklist
- [ ] Scope xác định rõ (In scope / Out of scope)
- [ ] Technical approach documented
- [ ] Files/components affected identified
- [ ] Breaking changes flagged
- [ ] Migration plan (if needed)
- [ ] Definition of Done defined
- [ ] UX/A11Y requirements (if UI change)
- [ ] Security considerations noted

### Template: Implementation Plan
```markdown
## Implementation Plan — QUA-xxx

### Goal
[1-2 sentences]

### Approach
[Technical approach]

### Files Affected
- `path/to/file.ts` — [what changes]

### Scope
**In scope:** [...]
**Out of scope:** [...]

### Definition of Done
- [ ] [criteria 1]
- [ ] [criteria 2]
- [ ] Tests pass
- [ ] TypeScript compiles

### Risks
- [risk 1]
```

---

## Phase 3: DEV

**Owner:** Software Agents (SA1-5)
**Input:** Spec'd issue (status: `todo`)
**Output:** PR on fork repo, issue status: `in_review`

### Workflow
1. **Checkout** issue via Paperclip API (`status: in_progress`)
2. **Create branch** from master: `fix/issue-description-qua-xxx` or `feat/...`
3. **Implement** changes following spec
4. **Test locally:**
   - `npx tsc --noEmit` (TypeScript check)
   - `npx vitest run` (unit tests)
   - Manual verification for UI changes
5. **Commit** with conventional commit message:
   - `fix(scope): description (QUA-xxx)`
   - `feat(scope): description (QUA-xxx)`
6. **Push** to fork remote and create PR
7. **Comment** on issue with PR link
8. **Update** issue status to `in_review`

### Code Standards
- TypeScript strict mode
- No `any` types (prefer `unknown` + type guards)
- No secrets in code
- No OWASP top-10 violations
- Conventional commits
- Co-Author attribution for AI-generated code

### Branch Naming
- Bug fix: `fix/short-description-qua-xxx`
- Feature: `feat/short-description-qua-xxx`
- A11Y: `fix/component-a11y-qua-xxx`
- Refactor: `refactor/short-description-qua-xxx`

---

## Phase 4: QA

**Owner:** QA Tester / CTO
**Input:** PR + issue in `in_review`
**Output:** QA sign-off or changes requested

### Checklist
- [ ] Code review: correctness, style, security
- [ ] TypeScript compiles without new errors
- [ ] Tests pass (no regressions)
- [ ] New behavior has test coverage
- [ ] UI changes: visual review
- [ ] A11Y changes: WCAG 2.1 AA compliance verified
- [ ] No console errors or warnings introduced
- [ ] Performance: no obvious regressions

### QA Review Template
```markdown
## QA Review — QUA-xxx

**Verdict:** ✅ APPROVED / ❌ CHANGES REQUESTED

### Checks
- [ ] Code correctness
- [ ] TypeScript clean
- [ ] Tests pass
- [ ] No regressions
- [ ] [Category-specific checks]

### Findings
[Any issues or observations]

### Sign-off
Reviewer: [name] | Date: [date]
```

---

## Phase 5: RELEASE

**Owner:** CTO / SA2 (merge coordinator)
**Input:** QA-approved PR
**Output:** Code merged to master and pushed to remotes

### Workflow
1. **Merge** PR branch into master (local merge preferred)
2. **Resolve** any merge conflicts
3. **Verify** build still passes after merge:
   - `npx tsc --noEmit --project server/tsconfig.json`
   - `npx tsc --noEmit --project ui/tsconfig.json`
   - `npx vitest run`
4. **Push** master to both remotes (`fork` + `hung-macmini`)
5. **Close/merge** PR on GitHub
6. **Update** issue status to `done`
7. **Comment** on issue with merge confirmation

### Release Cadence
- **Continuous**: PRs merged as they pass QA (no batching delay)
- **Batch merge**: When multiple PRs are ready, merge in priority order
- **Hotfix**: Critical fixes bypass QA batch queue

---

## Roles & Responsibilities

| Role | Intake | Spec | Dev | QA | Release |
|------|--------|------|-----|-----|---------|
| Board/CEO | ★ Request | | | | Approve (critical) |
| CTO | ★ Triage | ★ Technical spec | Review | Approve | ★ Merge |
| PM | ★ Prioritize | ★ Product spec | | | |
| SA1-5 | | Estimate | ★ Code | | Support |
| QA Tester | | | | ★ Validate | |
| UI/UX | UX audit | ★ Design spec | A11Y code | UX review | |

★ = Primary responsibility

---

## Definition of Done (DoD)

An issue is considered **done** when:

1. **Code complete**: All acceptance criteria met
2. **Tests pass**: No new test failures, new behavior covered
3. **Type-safe**: TypeScript compiles without new errors
4. **Reviewed**: QA sign-off received
5. **Merged**: Code in master branch
6. **Deployed**: Pushed to all remotes
7. **Tracked**: Issue status updated to `done` with merge comment

---

## Code Review Checklist

### Correctness
- [ ] Logic matches spec and acceptance criteria
- [ ] Edge cases handled
- [ ] Error handling appropriate (not excessive)

### Security
- [ ] No secrets or credentials in code
- [ ] No XSS/injection vectors
- [ ] Input validation at system boundaries

### Quality
- [ ] No unnecessary complexity
- [ ] No dead code or commented-out blocks
- [ ] Follows existing patterns in codebase
- [ ] No over-engineering

### Accessibility (for UI changes)
- [ ] ARIA attributes correct
- [ ] Keyboard navigation works
- [ ] Screen reader compatible
- [ ] Color contrast meets WCAG 2.1 AA

### Performance
- [ ] No N+1 queries
- [ ] No memory leaks
- [ ] Efficient rendering (no unnecessary re-renders)

---

## Escalation Path

1. **Blocker** → Comment on issue + notify CTO
2. **Architecture decision** → CTO approval required
3. **Scope change** → PM + CTO alignment
4. **Security concern** → Immediate CTO escalation
5. **Critical bug in production** → Hotfix flow (bypass batch QA)
