# Phase 55 Research: Native and Mobile Quick Capture Entry

## RESEARCH COMPLETE

### Planning Question

What needs to be known to plan Phase 55 well: a lightweight RealTycoon2 quick capture entry that works from mobile/PWA-style surfaces, survives offline/server failures through a local retry queue, shows connection/auth/sync state, and hands work into the existing capture draft review flow.

### Scope Anchors

- `NATIVE-01`: Operators can capture a One-Liner from a tray/PWA/mobile-friendly entry without navigating deep into the app.
- `NATIVE-02`: Offline or server-unavailable captures enter a visible local queue with retry state.
- `NATIVE-03`: The entry shows company/workspace connection, auth state, and last sync result.

Phase 55 is not full native distribution. App-store signing/updater/notarization, resident tray, Slack/Teams/webhook setup, review filters, and reliability reporting are deferred.

## Existing Assets

### PWA and Routing

- `ui/index.html` already links `ui/public/site.webmanifest`.
- `ui/src/main.tsx` already registers `ui/public/sw.js`.
- `ui/public/sw.js` uses network-first caching and skips API calls. It can support navigation fallback without introducing a PWA framework.
- `ui/src/App.tsx` owns company-prefixed and unprefixed route redirects. A quick-capture route should be added in both places.
- `ui/public/site.webmanifest` currently exposes `Paperclip`, which becomes product-facing once install/shortcut behavior is part of this phase.

### Existing Quick Capture

- `ui/src/components/FloatingOneLinerCapture.tsx` already provides compact quick capture, project memory, voice input, deterministic One-Liner parsing, and `rt2TasksApi.createInboundDraft` handoff.
- It currently has English product-facing labels: `Voice`, `Stop`, `Shortcut: c`, `Task title`, `Deliverable`, `Base price`, `Solo`, `Collab`. Reuse requires localization.
- `ui/src/pages/rt2/OneLinerPage.tsx` contains the dedicated composition page and project selection memory pattern.

### Capture Backend

- `packages/shared/src/types/rt2-task.ts` and `packages/shared/src/validators/rt2-task.ts` already include capture sources `web`, `floating`, `voice`, `slack`, `teams`, `webhook`, `mobile`, and `native`.
- `ui/src/api/rt2-tasks.ts` already supports `createInboundDraft(companyId, { source, text, channel, externalUserId, sourceInstallationId, eventId, eventTimestamp, signature })`.
- `server/src/services/rt2-work-board.ts` already creates inbound drafts, detects duplicates, records source evidence, creates initial revision rows, and returns queue-ready draft summaries.
- Existing server tests cover inbound draft creation, revisions, signed source evidence, and `eventId` preservation for signed capture. Add a mobile/native source assertion only if implementation changes the payload semantics.

### Board Review Handoff

- `DailyWorkPage` already owns selected company, current user, selected project, capture queue query, and invalidates queue/board/issues/tasks after capture mutations.
- `Rt2DailyBoard` already renders `One-Liner 보드 검수함`, revision editor, Korean capture statuses, duplicate warning, source evidence, and promote/fail/transition controls.
- Therefore Phase 55 should not create cards directly. Successful quick capture sends should create a capture draft and let the board review queue remain canonical.

## Recommended Plan Shape

### One Plan Is Enough

The work has one coherent user workflow:

1. Open a quick capture route or PWA shortcut.
2. See connection/auth/project state.
3. Type or review a One-Liner.
4. Save locally if disconnected or API send fails.
5. Retry and send through `createInboundDraft`.
6. See last sync and navigate to board review.

Splitting this into backend/schema waves would add coordination overhead without reducing risk, because the backend contract already exists from Phase 54.

### Implementation Approach

- Add a small queue module under `ui/src/lib/`, backed by guarded `localStorage`.
- Queue records should include: local id, company id nullable, project id nullable, source, channel, text, status, created/updated timestamps, last error, last attempted at, server draft id/status when sent.
- Use a local id as the inbound `eventId` for retry/idempotency evidence.
- Add a `QuickCapturePage` under `ui/src/pages/rt2/` that reuses parser concepts from the floating capture but is standalone and mobile-first.
- Add quick-capture routing in `App.tsx`, including unprefixed redirect.
- Add compact mobile navigation or manifest shortcut entry; avoid turning the bottom nav into a crowded sixth primary destination if the route can be launched from a quick action/shortcut.
- Update `site.webmanifest` to RealTycoon2 identity and add a `shortcuts` entry for quick capture.
- Localize floating capture English labels if reused or exposed as a shared path.

## Risks And Constraints

- **Sensitive local text:** Captures may contain business information. Keep queue bounded, avoid storing auth/session/secrets, and make device-local status visible.
- **False native claim:** Product copy must not imply app-store/tray distribution. Use "빠른 기록", "모바일/PWA", or "기기 임시 보관" language.
- **Duplicate sends:** Use stable local event id and visible sent state. Existing backend duplicate detection is text/source/hash-based, so UI should not blindly resend sent items.
- **Auth/company drift:** A queued item may be created before company/project is selected or after switching company. The UI must show connection blockers and only send when target context is explicit.
- **Identity regression:** PWA manifest still says Paperclip. Phase 55 must fix this because install metadata is product-facing.

## Validation Architecture

Use focused Vitest and identity checks:

- Queue unit tests: `ui/src/lib/rt2-quick-capture-queue.test.ts`
- Quick capture UI tests: `ui/src/pages/rt2/QuickCapturePage.test.tsx`
- Existing board/capture tests if changed: `ui/src/components/Rt2DailyBoard.test.tsx`
- Existing server route tests if source/event payload changes: `server/src/__tests__/rt2-task-routes.test.ts`
- Identity gate script/test: `pnpm run test:identity-gate` and `pnpm run rt2:identity-gate`
- Typecheck: `pnpm typecheck`

Recommended focused command:

```sh
pnpm exec vitest run ui/src/lib/rt2-quick-capture-queue.test.ts ui/src/pages/rt2/QuickCapturePage.test.tsx ui/src/components/Rt2DailyBoard.test.tsx packages/shared/src/rt2-task.test.ts server/src/__tests__/rt2-task-routes.test.ts
pnpm run test:identity-gate
pnpm run rt2:identity-gate
pnpm typecheck
```

Broad `pnpm test` is optional on this Windows host because previous phases recorded a known broad-suite timeout.
