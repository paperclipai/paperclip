# Plan: Team Mode on the Existing Company Model

## Summary
- Feature: persisted company-level presentation mode with shared terminology resolution.
- Expected outcome: operators can use Paperclip as either a company or a team without changing the underlying company-scoped domain model.
- Key constraints: no route renames, no internal role refactor, and changes should stay localized for easier upstream resync.

## Implementation slices
- [x] Slice 1: Materialize planning artifacts and a durable long-form design doc for team mode decisions, defaults, and deferred items.
- [x] Slice 2: Add `organizationMode` across schema, validators, shared types, service selection, and portability payloads.
- [x] Slice 3: Add a central terminology resolver plus team-aware onboarding and company settings support.
- [x] Slice 4: Relabel the highest-traffic operator surfaces with the shared terminology layer while preserving internal semantics.
- [x] Slice 5: Run verification, fix fallout, and document residual gaps or deferred follow-up surfaces.

## Acceptance criteria
- [x] `docs/prd.md`, `docs/plan.md`, and `docs/issues.md` describe the current task.
- [x] Testing approach and exact verification commands are listed.
- [x] Compatibility constraints and migration notes are captured.
- [x] Full repo verification passes or any blockers are explicitly documented.

## Verification commands
```text
pnpm -r typecheck
pnpm test:run
pnpm build
```

## Notes
- Internal identifiers remain company-scoped on purpose.
- The migration is additive: existing rows pick up `organization_mode = 'company'`.
- Team mode is presentation-only in this phase; the root agent still uses the internal `ceo` role.
- `pnpm test:run` had one transient timeout in `server/src/__tests__/opencode-local-adapter-environment.test.ts`; the isolated rerun passed immediately, so this was treated as a flaky environment test rather than a Team Mode regression.
