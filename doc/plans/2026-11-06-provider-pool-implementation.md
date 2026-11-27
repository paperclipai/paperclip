# Provider pool implementation plan

**Goal:** Automatically continue quota-limited work using the next eligible account in an ordered pool.

**Architecture:** Extend the existing AI connection router and its task affinity; persist account cooldowns by company and connection identity. Admit a separately recorded retry only after confirmed provider stop, preserving existing authorization, workspace, session and recovery invariants.

**Tech stack:** TypeScript, Drizzle/PostgreSQL, React, Vitest.

**Spec:** `doc/plans/2026-11-06-agent-provider-backup-design.md`.

## Tasks

1. Add a durable, company-scoped account cooldown with monotonic deadline updates, migration and tests for expiration, concurrent writes and tenant separation.
2. Extend pool configuration, selection and UI with an ordered failover mode; filter accounts against the durable cooldown and retain existing routing for other modes. Test order, skipped accounts, exhausted pools, authorization, and restart.
3. Wire confirmed quota outcomes into cooldown and bounded retry with safe ownership release and atomic task-pin transition. Keep provider identities isolated, reuse compatible sessions only, and verify handoff, Stop, retry races and quota-recovery interaction.
4. Update behavior documentation; run focused tests, token gates, repository typecheck, tests and build; review the complete diff and create the requested PR with the repository template. Track current-head checks and review comments.
