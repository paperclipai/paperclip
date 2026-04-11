---
name: org-engineering-baseline
description: >
  Use when implementing, refactoring, reviewing, or debugging code across
  repositories to enforce assumption checks, simplicity-first design, surgical
  scope control, and verification-backed completion. Use as an always-on
  baseline beneath repo-specific safety and contract rules.
---

# Org Engineering Baseline

A reusable behavior baseline for coding tasks across projects.

## Rule Priority

1. Direct user instructions
2. Repo-local `AGENTS.md` and safety constraints
3. This baseline skill

When rules conflict, follow the higher-priority source.

## Trivial-Task Fast Path

For obvious one-line or non-behavioral edits (typos, renames, comment cleanup),
use a lightweight version of this skill:

- keep assumptions explicit if ambiguity exists
- keep the diff minimal
- run proportionate checks

Do not force heavy process for trivial changes.

## Core Behaviors

### 1. Think Before Coding

- State assumptions explicitly before implementation.
- If requirements are ambiguous, present interpretations and choose one.
- If uncertainty blocks safe progress, ask for clarification.
- If a simpler valid approach exists, recommend it.

### 2. Simplicity First

- Implement only what is required.
- Avoid speculative abstractions and configuration.
- Prefer straightforward code over reusable architecture unless reuse is needed now.
- Remove complexity introduced by your own change.

### 3. Surgical Changes

- Edit only files required for the request.
- Keep unrelated refactors out of scope.
- Match local patterns unless they violate explicit safety constraints.
- If you notice unrelated issues, report them instead of silently fixing.

### 4. Goal-Driven Execution

- Define concrete success criteria before coding.
- Prefer tests/checks that fail first for behavior changes.
- Verify completion with explicit commands and outcomes.
- Do not claim success without evidence.

## Production Guardrails

Apply these for all non-trivial changes:

- Preserve API/schema/auth contracts unless change request says otherwise.
- Enforce data and tenant boundaries.
- Keep security-sensitive behavior explicit and reviewed.
- Update all affected layers when a contract changes.

## Standard Work Output

For meaningful tasks, include:

1. Assumptions and chosen interpretation
2. Short implementation plan
3. Scope statement (why each changed file is necessary)
4. Verification results (commands + pass/fail)
5. Residual risks or follow-ups

## PR Expectations

PR descriptions should include:

- assumptions
- alternatives considered
- scope justification
- verification evidence
- risks

## Anti-Patterns

- Silent assumption selection
- Overengineering for hypothetical future needs
- Drive-by edits unrelated to the request
- "Done" claims without verification output
