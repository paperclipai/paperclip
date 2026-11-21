---
name: code-simplification
description: >
  Reduces code complexity while preserving
  exact behavior for clarity and maintainability.
---

# Code Simplification Skill

Simplify code by reducing complexity while preserving exact behavior. The goal is not fewer lines — it's code that is easier to read, understand, modify, and debug. Every simplification must pass a simple test: "Would a new team member understand this faster than the original?"

## When to Use

- After a feature is working and tests pass, but the implementation feels heavier than it needs to be
- During code review when readability or complexity issues are flagged
- When you encounter deeply nested logic, long functions, or unclear names
- When refactoring code written under time pressure
- When consolidating related logic scattered across files
- After merging changes that introduced duplication or inconsistency

## When NOT to Use

- Code is already clean and readable — don't simplify for the sake of it
- You don't understand what the code does yet — comprehend before you simplify
- The code is performance-critical and the simpler version would be measurably slower
- You're about to rewrite the module entirely — simplifying throwaway code wastes effort

## Prerequisites

No setup beyond the project's own build, test, and version-control commands.

## How to Run

Load this skill when the task matches When to Use, work through Procedure in order, then confirm against Verification.

## Quick Reference

- The Five Principles
- 1. Preserve Behavior Exactly
- 2. Follow Project Conventions
- 3. Prefer Clarity Over Cleverness
- 4. Maintain Balance
- 5. Scope to What Changed
- The Simplification Process
- Step 1: Understand Before Touching (Chesterton's Fence)
- Step 2: Identify Simplification Opportunities
- Step 3: Apply Changes Incrementally
- Step 4: Verify the Result

## Procedure

### The Five Principles

1. **Preserve Behavior Exactly** — simplification must not change what the code does. Only reduce complexity, not alter semantics.
2. **Follow Project Conventions** — match the codebase's existing style, naming, and patterns rather than introducing your own preferences.
3. **Prefer Clarity Over Cleverness** — readable code beats clever code. Avoid clever one-liners, obscure language features, and premature abstraction.
4. **Maintain Balance** — don't over-simplify into unreadable terseness, and don't leave unnecessary complexity. Find the sweet spot.
5. **Scope to What Changed** — simplify only the code you're touching. Don't use simplification as an excuse to refactor unrelated modules.

### The Simplification Process

**Step 1: Understand Before Touching (Chesterton's Fence)** — Don't remove code until you understand why it exists. Read tests, git history, and comments before simplifying.

**Step 2: Identify Simplification Opportunities** — Look for deeply nested logic, long functions, unclear names, duplicated code, dead code, over-engineered abstractions, and unnecessary layers.

**Step 3: Apply Changes Incrementally** — Make small changes, run tests after each one. Don't batch multiple simplifications into one commit.

**Step 4: Verify the Result** — Run the full test suite. Confirm behavior is unchanged. Ask whether a new team member would understand the simplified code faster than the original.

## Pitfalls

- Simplifying code you don't understand
- Removing defensive code without understanding why it was added
- Changing behavior in the name of simplification
- Over-simplifying into unreadable terseness
- Simplifying throwaway code that will be rewritten anyway
- Introducing new abstractions to "fix" duplication (sometimes duplication is better than the wrong abstraction)

## Verification

- [ ] Behavior is unchanged after simplification
- [ ] All tests pass
- [ ] Code is easier to read and understand
- [ ] No new complexity was introduced elsewhere
- [ ] Project conventions are followed
- [ ] A new team member would understand the code faster than the original