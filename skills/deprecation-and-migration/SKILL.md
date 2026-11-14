---
name: deprecation-and-migration
description: >
  Plans safe deprecations and staged data migrations
  that move users from old to new systems.
---

# Deprecation and Migration Skill

Code is a liability, not an asset. Every line has ongoing maintenance cost. Deprecation removes code that no longer earns its keep; migration moves users safely from old to new systems.

## When to Use

- Replacing an old system, API, or library with a new one
- Sunsetting a feature no longer needed
- Consolidating duplicate implementations
- Removing dead code everybody depends on but nobody owns
- Planning lifecycle of a new system (deprecation planning starts at design time)

## Prerequisites

No setup beyond the project's own build, test, and version-control commands.

## How to Run

Load this skill when the task matches When to Use, work through Procedure in order, then confirm against Verification.

## Quick Reference

- Code is a liability — value is functionality, not the code itself
- Hyrum's Law: every observable behavior becomes depended on — removal needs active migration
- Deprecation planning starts at design time — ask how to remove in 3 years
- Advisory vs compulsory deprecation — default to advisory
- Migration: build replacement → announce → migrate incrementally → remove old
- Schema changes: expand/contract, never rename in place

## Procedure

### Core Principles

Every line of code needs tests, documentation, security patches, dependency updates, and mental overhead. Value is the functionality, not the code. When less code provides the same functionality, remove the old.

### Hyrum's Law Makes Removal Hard

With enough users, every observable behavior — including bugs and timing quirks — becomes depended on. Users can't just switch when dependent on behaviors the replacement doesn't replicate. Deprecation requires active migration, not just announcement.

### Deprecation Planning Starts at Design Time

When building new, ask how you'd remove it in 3 years. Clean interfaces, feature flags, minimal surface area make deprecation easier.

### The Deprecation Decision

Answer before deprecating: does this still provide unique value? How many consumers depend on it? Does a replacement exist? What's migration cost per consumer? What's ongoing cost of NOT deprecating?

### Advisory vs Compulsory

Advisory: migration optional, old system stable — warnings, docs, nudges. Compulsory: security issues, blocks progress, unsustainable maintenance — hard deadline with migration tooling. Default to advisory.

### The Migration Process

Step 1: Build the replacement — cover all critical use cases, documentation, proven in production.
Step 2: Announce and document — deprecation notice with status, replacement, removal date, reason, migration guide.
Step 3: Migrate incrementally — one consumer at a time: identify touchpoints, update to replacement, verify behavior, remove old references, confirm no regressions.
Step 4: Remove old system — only after zero active usage verified; remove code, tests, docs, config, deprecation notices.

### Migration Patterns

Strangler: run old and new in parallel, route traffic incrementally 0%→100%, then remove.
Adapter: translate old interface calls to new implementation.
Feature flag: switch consumers old→new one at a time.
Database schema: expand/contract — add nullable column, dual-write, backfill in batches, switch reads, then contract (drop old column in separate deploy).

### Zombie Code

Nobody owns it but everybody depends on it. No commits 6+ months, no maintainer, failing tests unfixed, vulnerable dependencies. Either assign an owner or deprecate with concrete migration plan.

## Pitfalls

- "It still works, why remove it?" — maintenance cost grows silently
- "Someone might need it later" — rebuilding costs less than keeping unused code
- Deprecation without replacement available
- Deprecation announcement with no migration tooling or docs
- Soft deprecation advisory for years with no progress
- Zombie code with active consumers and no owner
- New features added to deprecated system
- Schema change and dependent code in same deploy
- Column renamed/dropped in place rather than expand/contract
- Migration with no tested down path

## Verification

- [ ] Replacement is production-proven covering all critical use cases
- [ ] Migration guide exists with concrete steps and examples
- [ ] All active consumers migrated (verified by metrics/logs)
- [ ] Old code, tests, documentation, configuration fully removed
- [ ] No references to deprecated system remain
- [ ] Deprecation notices removed
- [ ] Schema change ships in additive phases (expand → backfill → contract)
- [ ] Each migration has tested down path; backfills run in throttled batches
- [ ] Destructive steps ship in their own deploy after no code references old shape