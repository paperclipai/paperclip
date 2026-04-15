# Katya autonomy model — Phase 1 (Day 1/3)
Date: 2026-03-25
Owner: Felix
Status: Implemented (scaffolding + metadata docs)

## Summary
Added Katya autonomy controller scaffolding with due-state + weekly counter logic, plus encoded revision_requested-first ordering. Updated Pelergy workflow doc to include the required metadata template fields.

## Changed files
- server/src/services/katya-autonomy.ts (new)
- server/src/services/index.ts
- docs/pelergy-trial/MARKETING-WORKFLOW-V1.md

## Rollout checks
- Typecheck/build not run in this pass.
- Verify new exports compile in server bundle.
- Confirm docs render correctly in site build.

## Open risks
- Due-state logic is scaffolded only; no runtime wiring yet.
- Metadata template fields live in docs only; UI template insertion still pending.
- Weekly counter inputs are unvalidated; future schema validation needed.
