# Phase 55: Native and Mobile Quick Capture Entry - Context

**Gathered:** 2026-04-30
**Status:** Ready for planning
**Mode:** auto

<domain>
## Phase Boundary

Phase 55 creates a lightweight native/mobile-friendly quick capture entry for One-Liner work signals outside deep app navigation. It must show company/project workspace connection, auth state, local queue/retry state, and last sync result, then safely hand submitted captures into the existing persistent draft review flow.

This phase should not build full app-store signing/updater/notarization, a production resident OS tray binary, Slack/Teams/webhook source installation, broad review filters, reliability reports, or promotion-latency analytics. Those belong to future distribution scope, Phase 56, or Phase 57. Phase 55 may add a PWA/mobile quick-capture route, manifest shortcut/identity updates, a small local queue utility, focused UI entry points, and narrow tests around the existing inbound draft API.

</domain>

<decisions>
## Implementation Decisions

### Entry Channel Boundary
- **D-01:** Build a mobile-first quick capture surface as the recommended default: an installable PWA/mobile-friendly route plus launcher entry, not a full native tray binary or app-store package.
- **D-02:** The route should be reachable without navigating deep into daily work, for example `/:companyPrefix/quick-capture` plus an unprefixed redirect, mobile nav/shortcut entry, and a PWA manifest shortcut.
- **D-03:** The existing floating One-Liner capture can be reused or refactored for shared composition behavior, but Phase 55 should provide a standalone narrow-screen capture entry that works as the first screen in mobile/PWA standalone mode.
- **D-04:** Treat `source: "mobile"` as the canonical PWA/mobile quick-capture source. Use `source: "native"` only where a native shell or explicit native launcher contract is represented; do not imply full native distribution has shipped.
- **D-05:** Full resident tray behavior, app-store distribution, updater, notarization, global shortcut, and mobile push are deferred. If UI mentions tray/native in this phase, it must be framed as a lightweight quick entry or future distribution path, not a completed packaged app.

### Local Queue And Retry
- **D-06:** Add a bounded client-side local queue for offline/server-unavailable captures. The queue should store only the reviewed text payload and minimal context needed to retry, not secrets, tokens, or raw auth/session data.
- **D-07:** Use existing browser storage patterns for this phase, preferably a focused `localStorage`-backed queue module with parse/validation guards, per-company keys where possible, max item count/size, and corrupted-entry recovery. IndexedDB/background sync can be future hardening if the queue grows beyond lightweight capture.
- **D-08:** Queue item states should be explicit and user-visible: `임시 저장`, `전송 대기`, `전송 중`, `전송 실패`, `검수함 전송됨`. Do not hide failed retries behind silent background behavior.
- **D-09:** Retry should run in foreground on manual action, app focus, and `online` event. Do not rely on service-worker Background Sync for Phase 55.
- **D-10:** Each queued item should carry a durable client-generated id used as the inbound `eventId`/idempotency hint. A successful server response marks the item sent with draft id/status/last sync result; failed sends keep the item with the server/network error summary.
- **D-11:** Offline capture should not create UI-only board cards. The first server durable object remains the capture draft returned by `createInboundDraft`.

### Connection And Auth State
- **D-12:** The quick entry must show the selected company and selected project/workspace context near the input. In current code this maps to `selectedCompany` plus active project; label it in Korean as the current work context.
- **D-13:** Auth state must be visible. If the session is missing, expired, or not loaded, the operator can save a local device draft but cannot send it to the server until auth is restored.
- **D-14:** If no company or project context is selected, the entry should keep local input safe on the device and show a clear Korean blocked state (`회사 연결 필요`, `프로젝트 선택 필요`) instead of throwing generic API errors.
- **D-15:** Last sync result should be shown as a compact operational status: last sent time, created draft id/status when available, and most recent retry failure if any.
- **D-16:** The quick entry should not collect credentials, signing secrets, or external source setup details. Slack/Teams/webhook installation belongs to Phase 56.

### Draft Review Handoff
- **D-17:** Quick capture submission must use the existing `rt2TasksApi.createInboundDraft` / `rt2WorkBoardService.createInboundDraft` path, then flow into the board capture review inbox backed by `rt2_capture_drafts` and Phase 54 revision support.
- **D-18:** Submitted PWA/mobile captures should use `channel` values that preserve context, for example `quick-capture:{projectId}` or `mobile:{projectId}`, and should pass the local queue id as `eventId` when available.
- **D-19:** Promotion remains an operator review decision in the daily board `One-Liner 보드 검수함`; Phase 55 should not auto-promote quick captures.
- **D-20:** Duplicate, permission-blocked, and failed source statuses from the existing service should remain visible in the board review inbox. The quick entry can summarize them after send but must not reinterpret or suppress them.
- **D-21:** Query invalidation should cover capture queue, daily board, project tasks/issues, and any local queue status after a successful send. Existing `DailyWorkPage` mutation invalidation is the reference pattern.

### PWA Identity And Navigation
- **D-22:** Update `ui/public/site.webmanifest` so install surfaces say RealTycoon2, not Paperclip. Add quick-capture shortcut metadata if supported by the manifest format.
- **D-23:** Keep `ui/public/sw.js` network-first, but make offline navigation behavior friendly enough that the quick capture route can load from cache and store a local draft when the API is unavailable. Do not build a broad offline app shell rewrite.
- **D-24:** Product-facing quick capture copy must be Korean-first. Current English labels in the floating capture (`Voice`, `Stop`, `Shortcut: c`, `Task title`, `Deliverable`, `Base price`, `Solo`, `Collab`) should be localized if that component is reused or appears in the new entry.
- **D-25:** Mobile nav should remain compact. Prefer an icon entry or route shortcut for quick capture over adding a large explanatory panel. The first viewport should be the actual capture input plus connection/queue state.

### Verification
- **D-26:** Add focused unit tests for the local queue utility: parse guards, max queue behavior, status transitions, corrupted storage recovery, and successful/failed retry updates.
- **D-27:** Add focused UI tests for the quick capture route/component covering Korean company/project/auth state, offline/server failure local queue behavior, retry action, last sync summary, and successful handoff to the capture review queue.
- **D-28:** Extend existing capture route/shared tests only where needed to verify `source: "mobile"`/`source: "native"` and client `eventId` handling through `createInboundDraft`.
- **D-29:** Add or update identity/PWA checks so `site.webmanifest` no longer exposes Paperclip as the installed product name.
- **D-30:** Verification should include `pnpm typecheck`, focused Vitest for changed shared/server/UI files, `pnpm run test:identity-gate`, and `pnpm run rt2:identity-gate`. Run broad `pnpm test` only if feasible; the known Windows broad-suite timeout remains accepted host debt if focused checks pass.

### the agent's Discretion
- Exact route name and component split, provided the entry is mobile/PWA-friendly, reachable outside deep app navigation, and does not replace daily board review.
- Exact storage key naming and local queue module shape, provided it is bounded, validated, company-aware when possible, and does not store secrets.
- Exact retry timing and copy details, provided state is visible and retry is foreground/manual-safe.

</decisions>

<specifics>
## Specific Ideas

- Phase 54 already created persistent draft revision semantics and explicitly deferred native tray/PWA/mobile capture entry to Phase 55.
- The existing DB/shared/client/service code already recognizes `web`, `floating`, `voice`, `slack`, `teams`, `webhook`, `mobile`, and `native` capture sources.
- `FloatingOneLinerCapture` already creates inbound drafts and can inform the parser/review fields, but it currently has several English labels and no durable offline queue.
- `ui/index.html` already points to `site.webmanifest`, and `ui/src/main.tsx` registers `sw.js`; Phase 55 can use those existing PWA hooks instead of adding a new PWA framework.
- `site.webmanifest` currently says `Paperclip`; because Phase 55 introduces install/shortcut surfaces, this becomes product-facing and should be corrected to RealTycoon2.
- `DailyWorkPage` already owns selected company, current user, selected project, capture queue query, and capture mutation invalidation. Reuse those patterns for send success and queue refresh.

</specifics>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase Scope And Requirements
- `.planning/PROJECT.md` - v2.9 milestone focus, RT2-first product rule, Korean-first work loop, and deferred full native distribution/federation/autonomy scope.
- `.planning/REQUIREMENTS.md` - `NATIVE-01`, `NATIVE-02`, and `NATIVE-03` Phase 55 requirements.
- `.planning/ROADMAP.md` - Phase 55 goal and success criteria under v2.9.
- `.planning/STATE.md` - Current v2.9 planning state and milestone handoff.
- `.planning/phases/54-persistent-capture-draft-revision/54-CONTEXT.md` - Locked persistent draft revision, board review, promotion, and deferred Phase 55 boundary.
- `.planning/phases/51-one-liner-to-board-capture-flow/51-CONTEXT.md` - Locked One-Liner board review flow and existing web/floating capture handoff decisions.
- `.planning/phases/52-supporting-surfaces-and-identity-regression-gate/52-CONTEXT.md` - Locked Korean-first product-facing identity and compact board surface constraints.
- `AGENTS.md` - Korean-first communication and RealTycoon2 terminology instruction for this repo.

### PWA, Navigation, And Entry Surfaces
- `ui/public/site.webmanifest` - Current install manifest; must be RealTycoon2-branded and can define quick-capture shortcut metadata.
- `ui/public/sw.js` - Existing network-first service worker and offline navigation fallback.
- `ui/src/main.tsx` - Service worker registration and app bootstrap.
- `ui/src/App.tsx` - Route tree and company-prefixed/unprefixed redirects; add quick-capture routing here.
- `ui/src/components/MobileBottomNav.tsx` - Mobile navigation entry point if quick capture is exposed in bottom nav.
- `ui/src/components/FloatingOneLinerCapture.tsx` - Existing quick capture modal, parser/review behavior, voice affordance, and inbound draft creation path to reuse/localize.
- `ui/src/pages/rt2/OneLinerPage.tsx` - Existing dedicated One-Liner composition surface and project selection memory.
- `ui/src/context/CompanyContext.tsx` - Selected company storage and context for connection state.
- `ui/src/api/auth.ts` - Session query used to display auth state.

### Capture Draft Contracts And Backend
- `packages/shared/src/types/rt2-task.ts` - Capture source/status/queue/detail contracts, including `mobile` and `native` source types.
- `packages/shared/src/validators/rt2-task.ts` - Inbound draft, revision, transition, promote, and fail validators.
- `ui/src/api/rt2-tasks.ts` - Client helpers for create inbound draft, capture queue, draft detail/revision/transition, promote/fail.
- `server/src/routes/rt2-tasks.ts` - RT2 task/capture routes and activity logging.
- `server/src/services/rt2-work-board.ts` - Capture source lookup, duplicate detection, inbound draft creation, revision-aware promotion, queue listing, and status handling.
- `packages/db/src/schema/rt2_work_board.ts` - Capture source/draft/revision tables and existing status/source fields.
- `server/src/__tests__/rt2-task-routes.test.ts` - Focused server route tests to extend if source/idempotency behavior changes.
- `packages/shared/src/rt2-task.test.ts` - Shared capture contract tests to extend for mobile/native queue payloads.

### Board Review Integration
- `ui/src/pages/rt2/DailyWorkPage.tsx` - Capture queue query, auth/company/project context, and mutation invalidation pattern.
- `ui/src/components/Rt2DailyBoard.tsx` - Board capture review inbox and Korean draft revision/review UI.
- `ui/src/components/Rt2DailyBoard.test.tsx` - Focused component tests for capture review behavior.
- `ui/src/lib/queryKeys.ts` - Existing query keys for capture queue, board, task, project, and auth state.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `rt2WorkBoardService.createInboundDraft` already handles source lookup, signing/permission state, duplicate detection, semantic context, initial revision creation, source evidence, and audit trail.
- `rt2_capture_drafts` and `rt2_capture_draft_revisions` already provide durable server-side draft/revision records once a queued item successfully reaches the API.
- `rt2TasksApi.createInboundDraft` already accepts `source`, `text`, `channel`, `externalUserId`, `sourceInstallationId`, `eventId`, `eventTimestamp`, and `signature`.
- `DailyWorkPage` already fetches auth/session, selected company/project, capture queue, and invalidates the right queries after capture actions.
- `Rt2DailyBoard` already renders the capture review inbox, draft revision edit fields, Korean status labels, source evidence, duplicate warning, and promote/fail/transition controls.
- `FloatingOneLinerCapture` already has compact quick capture, voice input, parser review fields, project memory via `localStorage`, and board-review handoff.
- `site.webmanifest` and `sw.js` already exist, so PWA work can stay focused on identity, shortcut, and offline-friendly quick capture rather than introducing a new PWA stack.

### Established Patterns
- Product-facing surfaces are Korean-first and RealTycoon2-branded; internal package names and API identifiers can remain Paperclip-derived.
- Existing UI stores small user preferences in `localStorage` with guarded reads/writes; Phase 55 can follow that pattern for a bounded queue but must validate/cap payloads.
- React Query is the client data boundary; successful capture sends should invalidate capture queue and board/task/project queries rather than inserting detached cards.
- The daily board remains the review and promotion authority. Quick capture only gets work signals into draft review.
- Focused tests and typecheck are the expected verification route on this Windows host; broad `pnpm test` can be recorded as accepted debt if it hits the known timeout.

### Integration Points
- Add a quick-capture route/page and route redirects in `ui/src/App.tsx`.
- Add or refactor a reusable quick capture composition component from `FloatingOneLinerCapture` if that avoids duplicating parser/review fields.
- Add a small local queue utility under `ui/src/lib/` or a focused RT2 quick-capture module with tests.
- Update `site.webmanifest` with RealTycoon2 name/description and shortcut to the quick-capture entry.
- Optionally tune `sw.js` navigation fallback copy/cache name where it affects product-facing install/offline behavior.
- Extend UI tests around the quick capture route and queue behavior; extend shared/server tests only if event id/source semantics are changed.

</code_context>

<deferred>
## Deferred Ideas

- Full app-store signing, updater, notarization, release channel, resident OS tray app, global shortcut, and mobile push notifications remain future native distribution scope.
- Slack/Teams/webhook source installation, signing secret configuration, callback URL setup, and source health management belong to Phase 56.
- Board review inbox filters, capture reliability report, source-level failure aggregation, retry metrics, and promotion latency belong to Phase 57.
- Autonomous Jarvis apply without approval, cross-company federation full apply, and public/open capture marketplace remain outside v2.9 scope.

</deferred>

---

*Phase: 55-native-and-mobile-quick-capture-entry*
*Context gathered: 2026-04-30*
