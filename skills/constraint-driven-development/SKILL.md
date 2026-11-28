---
name: constraint-driven-development
description: >
  Turns written project constraints into enforced
  build rules that outlive the conversation.
---

# Constraint-Driven Development Skill

Produces a written record of this project's quality bar, with numbers, that outlives the conversation and can be checked mechanically. Other skills describe what good looks like in prose; this skill enforces it.

## When to Use

- Starting a project or significant feature with no quality bar written down
- User asks to set up constraints, add quality gates, or define standards
- An agent is producing volume nobody reads line by line
- Coverage, performance, or accessibility numbers get argued per-PR instead of decided once

## Prerequisites

No setup beyond the project's own build, test, and version-control commands.

## How to Run

Load this skill when the task matches When to Use, work through Procedure in order, then confirm against Verification.

## Quick Reference

- Floor (always enforced): no new suppression comments, no unimplemented stubs, no skipped tests without reason, no secrets in source, never weaken this file
- Dimensions: types, lint, secrets, coverage, security, accessibility, performance — each with a tool and command
- Stages: BUILD (types, lint, secrets, floor under 5s), VERIFY (related tests, coverage on changed lines under 90s), REVIEW (everything), SHIP (direction checks in CI)
- Ratchets: record today's value and direction instead of inventing aspirational numbers

## Procedure

### Loading Constraints

Don't run the interview in non-interactive contexts (CI, /loop, autonomous runs). Apply the Floor instead and flag the rest for a human.

### Step 1: Detect before you ask

Gather language and stack from package.json/pyproject.toml, test runner from dev deps, existing linters from eslint.config/biome.json/.ruff.toml, coverage from existing output, CI config, and agent harness from AGENTS.md. Report findings in two lines, then ask only what's left.

### Step 2: Four questions, each with a default

Follow one-question-at-a-time discipline; every question has a default so "I don't know" still produces a working config:

Q1: Beyond the floor, which do you want enforced? (coverage, security scanning, performance budgets, accessibility, architecture boundaries). Default: coverage and security scanning.
Q2: When a check fails mid-task, block or warn? Default: block on floor, warn on everything else for the first two weeks.
Q3: Target numbers, or measure today and hold that line? Default: measure and hold.
Q4: Slowest check tolerated before handing work back? Default: 90 seconds at task end, unlimited in CI.

Stop at four questions.

### Step 3: Write CONSTRAINTS.md

One file at repo root with Floor, Enforced with Numbers (table: dimension, rule, checked by, runs at), Measured Not Yet Enforced (metric, today, direction), and Exceptions (ID, rule, path, reason, owner, expires). Every row names the command producing the verdict.

Add one line to AGENTS.md and CLAUDE.md: "Read CONSTRAINTS.md before writing code. Do not weaken it to make a change pass."

### Step 4: Install what each dimension needs

Name a de facto tool per dimension (tsc, mypy, eslint/biome/ruff, vitest/coverage, semgrep, gitleaks, osv-scanner, lighthouse, size-limit, axe-core, dependency-cruiser) and add scripts: check:fast, check:task, check:full.

CONSTRAINTS.md is canonical; scripts are convenience wrappers mirroring it.

### Step 5: Wire it to the lifecycle

Scope checks to the diff. Cost decides placement — anything over a few seconds moves out of the edit loop. BUILD runs types/lint/secrets/floor under 5s; VERIFY runs related tests with coverage under 90s; REVIEW runs everything; SHIP runs direction checks in CI.

### Step 6: Guard the bar itself

At review time watch for: threshold moved, test got easier (skip/delete), checker silenced (@ts-ignore/eslint-disable), unfinished work (stubs, empty catch), new exception row. Compare CONSTRAINTS.md against branch point state. Tightening is silent; loosening is loud.

### Step 7: Ratchets, when you don't have a number

Record where you are today with a direction, then refuse to get worse. Coverage of changed lines ≥ 80%, project coverage must not fall, mutation score ≥ 60%, nothing at high or above for dependencies, LCP ≤ 2500ms, CLS ≤ 0.1, zero critical/serious axe violations.

## Pitfalls

- Setting a budget the codebase fails today with no plan to reach it
- Writing a number into CONSTRAINTS.md with no tool behind it
- Hand-rolling a checker when a de facto one exists
- Every constraint checked only by the project's own tests
- CONSTRAINTS.md changed in the same commit as the failing feature
- Slow checks landing in the edit loop so someone passes --no-verify

## Verification

- [ ] CONSTRAINTS.md exists and every number has a stated reason
- [ ] Floor passes on current codebase without changes
- [ ] Every chosen dimension has a tool installed and a command that runs today
- [ ] Each constraint says where it runs; fast stage stays under a few seconds
- [ ] At least one constraint is external (not this project's own tests)
- [ ] Measured-only metrics record today's value and direction
- [ ] Exceptions have an owner and expiry date
- [ ] AGENTS.md or CLAUDE.md points at the file
- [ ] Trial run on current branch produces no failures the user disagrees with