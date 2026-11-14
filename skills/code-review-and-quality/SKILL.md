---
name: code-review-and-quality
description: >
  Reviews code changes across correctness,
  readability, architecture, security, and performance.
---

# Code Review and Quality Skill

Multi-dimensional code review with quality gates. Every change gets reviewed before merge — no exceptions. Review covers five axes: correctness, readability, architecture, security, and performance.

## When to Use

- Before merging any PR or change
- After completing a feature implementation
- When another agent or model produced code you need to evaluate
- When refactoring existing code
- After any bug fix (review both the fix and the regression test)

## Prerequisites

No setup beyond the project's own build, test, and version-control commands.

## How to Run

Load this skill when the task matches When to Use, work through Procedure in order, then confirm against Verification.

## Quick Reference

### Review: [PR/Change title]

#### Context
- [ ] I understand what this change does and why

#### Correctness
- [ ] Change matches spec/task requirements
- [ ] Edge cases handled
- [ ] Error paths handled
- [ ] Tests cover the change adequately

#### Readability
- [ ] Names are clear and consistent
- [ ] Logic is straightforward
- [ ] No unnecessary complexity

#### Architecture
- [ ] Follows existing patterns
- [ ] No unnecessary coupling or dependencies
- [ ] Appropriate abstraction level
- [ ] Refactors reduce complexity rather than relocate it
- [ ] No feature logic in shared modules; file stays within a healthy size

#### Security
- [ ] No secrets or credentials hardcoded
- [ ] Input validated at boundaries
- [ ] No new attack surface introduced
- [ ] Dependencies checked for known vulnerabilities

#### Performance
- [ ] No N+1 queries or unnecessary re-renders
- [ ] No blocking operations on hot paths
- [ ] Caching used where appropriate
- [ ] Bundle size impact considered

## Procedure

### 1. Understand the Change

Read the full diff, associated ticket, and any linked designs before commenting. Ask what the change does and why before evaluating how it does it.

### 2. Review by Axis

Walk through correctness, readability, architecture, security, and performance in order. Use the Quick Reference checklist for each axis. Leave comments that are specific, actionable, and kind — cite line numbers and suggest alternatives when blocking.

### 3. Require Self-Review First

No reviewer should verify their own work. The author must self-review against the checklist before requesting review from others. Fresh context finds what the author misses.

### 4. Decide: Approve, Request Changes, or Block

Approve when all axes pass. Request changes for fixable issues. Block for security risks, data loss, or architectural decisions that need broader discussion. Re-review after the author addresses feedback.

## Pitfalls

- Rubber-stamping PRs without reading the diff
- Reviewing implementation details instead of behavior
- Letting nits block merge while missing real bugs
- Reviewing your own changes
- Approving changes you don't understand
- Missing security implications of new dependencies or endpoints

## Verification

- [ ] Every change reviewed before merge
- [ ] All five review axes covered (correctness, readability, architecture, security, performance)
- [ ] Author self-reviewed before requesting external review
- [ ] Review comments are specific, actionable, and cite line numbers
- [ ] Security implications considered for new code
- [ ] Performance impact assessed for hot paths
- [ ] Tests cover the change adequately
- [ ] Re-review performed after author addresses feedback