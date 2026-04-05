---
title: Hermes Local Mainstream Deviations
summary: Paperclip-core changes required for Hermes parity that do not live inside the hermes-local adapter package
---

This file tracks the Paperclip changes required to make `hermes_local` reproducible and shareable without relying on one-off local tweaks.

These are called "mainstream deviations" because they live outside `packages/adapters/hermes-local/`.

## Why this exists

Some Hermes integration work cannot be solved inside the adapter package alone.

Examples:

- host registries decide whether dynamic model listing and session codecs are even called
- approval routes decide which wake reasons are emitted
- issue routes decide which API payload aliases and error messages agents see
- heartbeat services decide whether wakeups are coalesced or replayed correctly

Keeping this list explicit makes it much easier to review, upstream, and maintain.

## Current non-adapter changes

### Registry and CLI parity

- `server/src/adapters/registry.ts`
- `cli/src/adapters/registry.ts`

Why:

- Hermes needs host-side `listModels()` wiring so the UI shows real Hermes-configured models instead of a default fallback.
- Hermes also needs host-side session-management wiring so saved sessions can be resumed across Paperclip wakes.
- The CLI registry needs Hermes registration too, otherwise `paperclipai ... --watch` falls back to generic process formatting.

### Approval lifecycle and comment compatibility

- `server/src/routes/approvals.ts`
- `server/src/services/approvals.ts`
- `packages/shared/src/validators/approval.ts`

Why:

- the requesting agent must wake on `approved`, `revision_requested`, and `rejected`
- those wakes must include approval-type and payload-summary fields so Hermes can reuse approved hires instead of submitting duplicates
- approved hire payloads must be reconciled back onto the pending agent record, not just toggled from `pending_approval` to `idle`
- Paperclip needs to tolerate common agent-generated approval comment payload aliases such as `content` and `comments`

### Issue wake context and run replay behavior

- `server/src/services/issue-assignment-wakeup.ts`
- `server/src/services/heartbeat.ts`
- `ui/src/api/heartbeats.ts`

Why:

- hired Hermes workers need the actual task title/body in wake context, not just an issue id
- approval wakes that arrive while an issue run is already executing must be deferred and replayed, not silently merged into the stale run
- heartbeat log polling should not surface transient bootstrap `404`s during startup

### Issue creation compatibility and agent self-correction

- `server/src/routes/issues.ts`
- `packages/shared/src/validators/issue.ts`

Why:

- Hermes and other agents naturally guess `POST /api/issues` unless given a strong example
- Paperclip now returns a helpful error for that malformed route: use `/api/companies/{companyId}/issues`
- issue creation accepts `body` as a compatibility alias and normalizes it to `description`

This is intentionally broader than Hermes because it benefits every local agent runtime.

### Skill materialization and hire idempotency

- `server/src/routes/agents.ts`
- `server/src/routes/company-skills.ts`
- `server/src/services/company-skills.ts`
- `skills/paperclip/SKILL.md`
- `skills/paperclip-create-agent/SKILL.md`
- `skills/paperclip/references/company-skills.md`

Why:

- Hermes needs Paperclip runtime/company skills materialized locally before sync so imported Paperclip-managed skills show up as real Hermes skills
- GitHub-hosted skill imports now fall back to a shallow `git` snapshot when the GitHub contents/tree APIs are unavailable or rate-limited, so imports like `obra/superpowers` stay reproducible on real development machines
- repeated `agent-hires` calls for the same requester and source issue should reuse the existing hire approval instead of creating duplicates
- `/agent-hires` now also normalizes the common Hermes placeholder refs `$PAPERCLIP_AGENT_ID` and `$PAPERCLIP_TASK_ID` so recoverable quoting mistakes do not fail with a raw validation `400`
- missing-company skill requests should return `404` rather than an internal error
- the shared Paperclip skills outside the adapter package had to be updated for Hermes-safe env passthrough, correct `$PAPERCLIP_API_URL` usage, a stricter rule that Paperclip API mutations are terminal-only because Hermes `execute_code` sandboxes can resolve `PAPERCLIP_*` values as missing or `None`, and explicit guidance that wait-for-approval tasks stay open until the approval wake arrives

### Onboarding / browser flow parity

- `ui/src/components/OnboardingWizard.tsx`

Why:

- a second onboarding flow could previously bounce to the dashboard instead of opening the new issue cleanly
- the Hermes browser-based validation flow depends on deterministic post-create routing

## Design stance

These changes are intentionally conservative:

- prefer host fixes when the host owns the behavior
- keep compatibility aliases narrow and explicit
- document every non-adapter change so reviewers can tell what would need to be upstreamed or generalized later

## What still stays adapter-local

The following stay inside `packages/adapters/hermes-local/`:

- Hermes CLI execution planning
- prompt construction
- model detection and listing from Hermes config
- Hermes skill sync logic
- Hermes stdout parsing
- Hermes-specific docs and test fixtures
