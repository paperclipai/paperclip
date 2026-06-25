# THIAAA-920 Context Discipline + Claude Prompt Caching

Date: 2026-06-10
Issue: [THIAAA-920](/THIAAA/issues/THIAAA-920)
Parent: [THIAAA-47](/THIAAA/issues/THIAAA-47)

## Scope handled

This heartbeat closed the remaining low-risk token work still worth landing after the earlier infrastructure pass:

- confirm the wake-time context path agents are instructed to use
- make Claude prompt-bundle reuse visible in adapter invocation metadata
- conservatively trim hot-path instruction text without changing behavior

## Context-discipline audit

Per-agent/runtime path in the current checkout:

- `paperclip` skill hot path: instructs scoped wakes to skip inbox picking, use `GET /api/issues/{issueId}/heartbeat-context` first, then `GET /api/issues/{issueId}/comments/{commentId}` or `comments?after=` before full thread fetch.
- control-plane APIs present: `GET /api/agents/me/inbox-lite`, `GET /api/issues/:id/heartbeat-context`, and incremental comment fetch via `GET /api/issues/:id/comments?after=...&order=asc`.
- wake payload path present: adapters inject `PAPERCLIP_WAKE_PAYLOAD_JSON`; skill guidance treats it as first-class context and only falls back to thread fetch when `fallbackFetchNeeded=true` or broader history is genuinely needed.
- bundled onboarding instructions still pointed CEOs at a full issue listing path in `HEARTBEAT.md`; this heartbeat trimmed that wording to point back to the compact Paperclip-skill path instead of duplicating a heavier fetch habit.

Audit conclusion:

- The primary context-discipline behavior is already implemented in code and skill guidance.
- The remaining cheap fix in this scope was instruction cleanup so default bundles do not re-teach heavier fetch patterns.

## Claude prompt caching status

Claude in this repo already uses a stable Paperclip-managed prompt bundle:

- bundle root: `companies/<companyId>/claude-prompt-cache/<bundleKey>/`
- stable contents: managed skills plus combined `AGENTS.md` content with the path directive appended once
- session reuse gate: saved Claude sessions resume only when the prompt bundle key still matches

Changes landed here:

- Claude invocation metadata now records `cachedInstructionChars` and `promptBundleKeyChars` in `promptMetrics`.
- Claude `commandNotes` now explicitly distinguish:
  - fresh run: stable prompt bundle injected
  - resumed run: stable prompt bundle reused

Expected savings:

- No behavioral change to Claude execution.
- Better measurement of when cached instruction bytes are eligible for reuse.
- Easier telemetry/reporting for board follow-up without adding provider spend or wiring a new adapter.

## Instruction trims

Conservative wording trims landed in:

- `skills/paperclip/SKILL.md`
- `server/src/onboarding-assets/ceo/AGENTS.md`
- `server/src/onboarding-assets/ceo/HEARTBEAT.md`

What changed:

- removed repeated prose around scoped wakes and wake payload handling
- shortened delegation wording where it repeated the same rule twice
- removed one bundled CEO instruction that still nudged agents toward the heavier full-issue listing path

Behavioral intent was preserved:

- same checkout rules
- same wake acknowledgement rule
- same status/disposition rules
- same delegation/governance rules

## Verification

- `pnpm vitest server/src/__tests__/claude-local-execute.test.ts`

## Estimated impact

- Instruction trim delta is small but persistent on fresh sessions because these files are in the default onboarding surface.
- Claude prompt-bundle metadata does not reduce tokens by itself, but it makes the cacheable portion visible and measurable so future reporting can separate reused stable instructions from truly dynamic wake context.
- Context-discipline remains the main token saver: compact wake payload + `heartbeat-context` + comment deltas instead of routine full-thread replay.
