---
name: dev-methodology
description: Use when following structured development practices — TDD, systematic debugging, git worktrees, subagent coordination, verification. Core engineering methodology for quality code.
---

# Development Methodology Skill

Based on superpowers patterns for structured software development.

## Test-Driven Development (TDD)

Every code change follows RED → GREEN → REFACTOR:

### RED: Write a failing test first
```
1. Identify the behavior to implement
2. Write the simplest test that would verify it
3. Run the test — confirm it FAILS
4. If it passes, the test is wrong or the feature already exists
```

### GREEN: Make it pass with minimal code
```
1. Write the simplest code that makes the test pass
2. Do NOT optimize, refactor, or handle edge cases yet
3. Run the test — confirm it PASSES
4. Run ALL tests — confirm nothing else broke
```

### REFACTOR: Clean up while tests stay green
```
1. Remove duplication
2. Improve naming
3. Extract methods/functions if needed
4. Run ALL tests after each change
5. Commit when clean
```

## Systematic Debugging

When a bug is found, follow this structured approach:

```
1. REPRODUCE: Create a minimal reproduction case
2. ISOLATE: Binary search to find the exact failing component
3. HYPOTHESIZE: Form a specific theory about the cause
4. TEST: Design an experiment that would prove/disprove the theory
5. FIX: Make the minimal change that fixes the root cause
6. VERIFY: Confirm the fix AND add a regression test
7. REVIEW: Check for similar bugs in related code
```

**Anti-pattern**: Do NOT guess-and-check. Do NOT make multiple changes at once.

## Git Worktrees

For parallel development, use git worktrees instead of stashing:

```bash
# Create worktree for a feature
git worktree add ../project-feature-x feature-x

# Work in isolation — different directory, same repo
cd ../project-feature-x
# ... make changes, commit ...

# When done, merge and clean up
cd ../project
git merge feature-x
git worktree remove ../project-feature-x
```

Benefits:
- No stash conflicts
- Multiple features in parallel
- Each worktree has its own working directory
- Clean separation of concerns

## Subagent-Driven Development

For complex tasks, decompose into independent subtasks:

```
1. DECOMPOSE the task into independent units
2. DEFINE clear inputs/outputs for each unit
3. DISPATCH subagents for parallel execution
4. COLLECT results and verify integration
5. INTEGRATE the pieces
```

Rules for subagent tasks:
- Each task must be independently testable
- No shared mutable state between tasks
- Clear interface contracts at boundaries
- Prefer over-specifying inputs over under-specifying

## Verification Before Completion

Before marking any task as done:

```
[ ] All tests pass (including new ones)
[ ] No regressions in existing functionality
[ ] Code follows project conventions
[ ] No TODO/FIXME left unaddressed
[ ] Error handling covers realistic failure modes
[ ] Documentation updated if public API changed
[ ] Commit message accurately describes the change
```
