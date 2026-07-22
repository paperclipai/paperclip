# Status Cards (Experimental) — Design Plan

**Wireframes (deployed):** https://pages.paperclip.ing/pap-15023-status-cards/
**Feature flag:** `enableStatusCards` (Settings → Instance → Experimental), off by default.

## 1. Concept

A new experimental page of configurable **status cards**. Each card is created by a human from a **free-text interest prompt** ("issues in the Cloud, ID and Content projects, recently updated — tell me what to do next"). The Summarizer built-in agent **compiles that prose into a persistent, structured issue query set** plus an auto-generated title. From then on the harness knows the card's issue set as hard data: it watches for meaningful changes, and updates the card's summary — **incrementally, cheaply, and streamed live**. Cards can be refreshed manually, on a change-gated schedule, or reactively with a debounce; they can be archived (fully disarmed) and restored. Agents will eventually create/maintain cards too — the API allows it from day one; the v1 UI only exposes human authoring.

This deliberately builds **on top of the experimental Summaries stack**, not beside it: same Summarizer built-in agent (`server/src/services/built-in-agents.ts:398`, default model `claude-haiku-4-5`), same document+revision storage, same hidden-generation-issue orchestration, same streaming protocol (`useSummaryDraftStream`). Briefs is not a fit — it's a bare agent persona with no persistence/routes/UI.

## 2. What we reuse (verified in code)

| Concern | Reuse |
|---|---|
| Experimental flag | `packages/shared/src/validators/instance.ts:41` + both default blocks in `server/src/services/instance-settings.ts` + toggle card in `ui/src/pages/InstanceExperimentalSettings.tsx`; route gate copied from `PipelinesExperimentalGate.tsx`; server gate like `assertSummariesEnabled()` (`server/src/routes/summary-slots.ts:33`) |
| Summary generation | The `summarySlotService.generate()` pattern (`server/src/services/summary-slots.ts:438`): hidden issue assigned to Summarizer, prompt-as-description, `idempotencyKey` dedupe, wake via `queueIssueAssignmentWakeup` |
| Summary storage | `documents` + `document_revisions` (revision history, optimistic concurrency, `createdByRunId`) — same as `summary_slots` |
| Compiled query shape | `companySearchQuerySchema` (`packages/shared/src/validators/search.ts:136`): `q`, `status[]`, `priority[]`, `projectId`, `labelId`, `assignee*`, `updatedWithin` (`24h/7d/…`), `updatedAfter`, `sort`, `limit`. Single `projectId` per query → a card stores a **set of queries** (union semantics), which matches "the agent creates a set of queries" |
| Change detection | `activity_log` chokepoint (`logActivity`, `server/src/services/activity-log.ts:127`) + the routines **activity gate** (`evaluateActivityGate`, `server/src/services/routines.ts:1219`) — the exact "only run if something changed since last run" primitive |
| Scheduling | Master scheduler tick (`server/src/index.ts:978`) + `monitorNextCheckAt`-style due-timestamps with claim/stale-guard (pattern: `tickDueIssueMonitors`, `heartbeat.ts:6877`) |
| Streaming into the card | `useSummaryDraftStream.ts` + `parseSummaryDraftStream` (STATUS: lines + `<<<SUMMARY-DRAFT>>>` sentinels over run-log deltas + live-events WS) |
| Cost accounting | `cost_events` ledger (`packages/db/src/schema/cost_events.ts`) — already carries `issueId`/`heartbeatRunId`/tokens/`costCents`; card updates are attributable by joining on the card's generation issues |

**Gaps this feature adds (greenfield):** a saved/watched-query concept (none exists today), the text→query compile step, the per-card fingerprint diff, the debounce/rate-cap policy engine, per-card instructions (summary slots have no custom-prompt parameter today), and card-scoped cost rollups.

## 3. Data model (new tables)

**`status_cards`**
- `id`, `companyId`, `createdByUserId` / `createdByAgentId` (either — agent authoring is API-level v1)
- `title` (agent-maintained; human can pin/override), `interestPrompt` (text, source of truth)
- `queries` (jsonb: `CompanySearchQuery[]`, union semantics), `queryVersion` (int), `queryCompiledAt`, `queryCompiledByAgentId`
- `instructionsMode` (`none | append | replace`), `instructions` (text)
- `refreshPolicy` (jsonb): `{ mode: "manual" | "interval" | "reactive", intervalMinutes?, debounceSeconds?, maxUpdatesPerHour?, triggers: {statusTransitions: bool, membershipChanges: bool, humanComments: bool, assigneeChanges: bool, anyUpdate: bool}, activeHours?: {start, end, timezone}, dailyTokenCap }`
- `state` (`compiling | active | error | paused_budget | paused_hours`), `staleness`: `pendingChangeCount`, `lastChangeAt`
- `fingerprint` (jsonb: `{issueId → {status, updatedAt}}` for the last summarized result set), `fingerprintAt`
- `documentId` → documents (the summary), `lastUpdateRunKind` (`full | incremental`), `lastGeneratedAt`, `lastModel`, `generatingIssueId`, `failureReason`
- `archivedAt`, `archivedBy…`, timestamps. Index `(companyId, archivedAt)`, due-index `(companyId, nextEvalAt)`.

**`status_card_updates`** (audit + cost per update)
- `id`, `cardId`, `kind` (`compile | full | incremental`), `trigger` (`manual | interval | reactive | restore`), `generationIssueId`, `runId`
- `changes` (jsonb: the delta shown in "Integrated in this update": `[{issueId, identifier, from, to, changeKind}]`)
- `inputTokens`, `outputTokens`, `costCents`, `model`, `startedAt`, `finishedAt`, `status` (`ok | failed`), `error`

Summary bodies stay in `documents`/`document_revisions` (revision dropdown for free, like `SummarySlotCard`).

## 4. Text → query compilation

1. **Create**: `POST /status-cards` stores the card in `compiling` state and immediately enqueues a **compile task** — a hidden issue assigned to the Summarizer (same `generate()` pattern, idempotency key `status-card-compile:{cardId}:{promptHash}`).
2. The compile prompt instructs the agent to follow a new bundled skill **`status-card-query`** (sibling of `summarize-status` in `packages/skills-catalog`): it documents the `CompanySearchQuery` schema, union semantics, how to resolve project/label names to ids (via search extract endpoints), guidance (prefer narrow queries + `updatedWithin`, cap `limit`, when to use `q` free text), and the required write-back payload. This is the "documentation we hand to the agent whenever it must create or update a card query."
3. The agent writes back via an agent-only endpoint `PUT /status-cards/:id/query` — `{queries[], title, changeSummary}` — with the same tight authorization as `assertSummarizerWriter` (built-in key match + generation issue + run id). Then it continues into the **first full summary** in the same run (one wake, no second task).
4. **Recompile triggers**: human edits the interest prompt; human hits "Recompile" in debug view; or the agent, during a summary update, detects the query has drifted (e.g. referenced project renamed) and flags it (never silently rewrites — query changes always create a new `queryVersion` with provenance).
5. **Debug view** (temporary, behind the flag): shows interest text, compiled query JSON + version history, dry-run results (executes the stored queries directly — zero LLM), and an advanced raw-JSON editor. This is how we tune compile quality early; it can be removed/demoted later without touching the data model.

## 5. Refresh & update engine

**Change detection (cheap, token-free).** A scheduler tick (new `tickDueStatusCards`, wired into the master loop next to `tickScheduledTriggers`) evaluates non-archived cards whose `nextEvalAt` is due:
- Run the card's stored queries (plain SQL through `companySearchService`), diff against `fingerprint` → `{new, removed, changed[]}` filtered by the card's **trigger set** (default: status transitions to `blocked/in_review/done/cancelled` + membership changes; in-progress churn ignored — exactly the user's ask).
- Nothing significant → update `pendingChangeCount=0`, reschedule. **Zero tokens spent.**
- Changes + policy says wait (manual mode, outside active hours, debounce window open, rate cap hit, budget cap hit) → mark card **stale** (`pendingChangeCount`, delta strip in UI), reschedule.
- Changes + policy fires → enqueue an update task.

We evaluate on scheduler ticks (15–30s granularity) rather than subscribing per-card to the event bus in v1 — simpler, restart-safe, and the reactive mode's floor is a 60s debounce anyway. The activity-gate query pattern gives us "anything changed since last update" nearly for free; the plugin event bus remains an optimization path if per-tick query execution ever gets hot (see Open questions).

**Policies** (per card):
- **Manual** — never auto-runs; card still shows live staleness ("5 changes since last update").
- **Interval, change-gated** — every 5/15/30/60 min, but the agent only runs if the diff is non-empty. The common "working day" setting.
- **Reactive (debounced)** — fire `debounceSeconds` (default 60s) after the last significant change, capped at `maxUpdatesPerHour` (default 6). The "as fast as it feels" setting with a bounded worst case.
- Cross-cutting guardrails: **active hours** (outside them, changes accumulate and batch into one update at window open) and a **daily token cap** per card (default 100k) → `paused_budget` state with a visible banner; manual refresh always allowed.

**Incremental vs full update.**
- **Incremental (default)**: prompt = card instructions + **previous summary markdown** + **only the changed issues** (delta details incl. old→new status, plus one-line context each). Agent patches the summary. Target ≈0.3–0.5k output tokens, streamed. This is the hyper-efficient path the user described: known set, known changes, known last post.
- **Full rebuild** when: delta > K issues (default 10), query or instructions changed, `queryVersion` bumped, every Nth incremental (drift guard, default 10), restore-from-archive refresh, or explicit "Full refresh" menu action. Uses a bounded snapshot exactly like `buildScopeSnapshot` (grouped Blocked / In review / In progress / Recently done, capped rows).
- Both run through the same hidden-issue mechanism with idempotency keys (`status-card-update:{cardId}:{fingerprintHash}`) so bursts coalesce; one in-flight update per card (like `generatingIssueId` dedupe).

**Prompting.** Default update prompt keeps the Summarizer's house format (`**Decide:**` / `**Recent work:**`, few links, colloquial). `instructionsMode=append` concatenates the card's instructions after the default; `replace` substitutes the task-format section but keeps the mechanical contract (streaming sentinels, write-back payload, "don't call issue-list endpoints"). Both offered in v1 for experimentation, as requested.

## 6. Cost model & visibility

Estimated with the Summarizer default `claude-haiku-4-5`:
- **Incremental**: ~1–2k in / ~0.3k out ≈ **$0.003–0.006 per update**. A busy card on 15-min change-gated over a 9-hour day: ~10–18 real updates ≈ **$0.03–0.10/day**.
- **Reactive worst case** (6/hr cap, 9 active hours): ~54 updates ≈ **$0.15–0.35/day per card**.
- **Full rebuild**: ~5–8k in / ~1k out ≈ **$0.01–0.02 each**.
- Change detection itself is SQL-only: $0.

Surfacing: every update writes a `cost_events` row (existing ledger) + denormalized tokens/cost onto `status_card_updates`. UI shows per-update lines in the detail drawer, per-card "today" in the footer, page-level "today" meter, lifetime cost on archived rows, and a cost preview in the create flow derived from the chosen policy. Caps enforced from the same numbers.

## 7. UX summary (see wireframes)

1. **Board** — card grid; states: compiling / fresh / stale / updating / error / paused / archived. Stale and error cards never go blank: last good summary stays visible.
2. **Create** — one free-text field; card appears instantly (optimistic) and compiles in the background; optional step 2 configures instructions + policy while it works.
3. **Detail drawer** — full summary, "Integrated in this update" change list (auditability of incremental updates), watched issues, revision history, per-update cost.
4. **Settings tab** — policy, trigger set, active hours, caps.
5. **Debug view** — interest text / compiled query / dry run (temporary).
6. **Archived tab** — list with lifetime cost; restore returns the card **stale**, never auto-runs on restore.
7. Streaming: incremental updates stream into a delta banner atop the old summary; full rebuilds stream like today's `SummarySlotCard`.

## 8. API surface (all under the experimental gate)

- `GET/POST /api/companies/:companyId/status-cards` · `GET/PATCH/DELETE /status-cards/:id` (PATCH covers prompt/instructions/policy/title-pin/archive/restore)
- `POST /status-cards/:id/refresh` (`{full?: boolean}`) — board/user, and agent-allowed for future agent authoring
- `POST /status-cards/:id/recompile` · `GET /status-cards/:id/dry-run` · `GET /status-cards/:id/updates` (history+costs)
- Agent write-back (Summarizer-only, `assertSummarizerWriter`-grade checks): `PUT /status-cards/:id/query`, `PUT /status-cards/:id/summary`
- Permissions: v1 cards are company-visible, mutable by board/users with `tasks:assign`-level permission; SecurityEngineer to review the agent write path + query execution respecting low-trust boundaries (`lowTrustBoundary` filter already exists in issue search).

## 9. Proposed build phases (child issues after approval)

| Phase | Scope | Owner | Blocked by |
|---|---|---|---|
| P1 | Flag + schema + CRUD/archive API + `status_card_updates` ledger | CodexCoder | — |
| P2 | Compile pipeline: `status-card-query` skill, compile task, query write-back auth, debug endpoints (dry-run/recompile) | CodexCoder (+SecurityEngineer review of write-back & query authz) | P1 |
| P3 | UI: board, create flow, detail drawer, settings, debug, archived; streaming reuse; screenshots required | ClaudeCoder (+UXDesigner review) | P1 (parallel with P2 after API stubs) |
| P4 | Update engine: fingerprint diff, scheduler tick, policies/debounce/caps/active-hours, incremental+full update prompts | CodexCoder | P2 |
| P5 | Cost surfacing end-to-end + QA e2e (create→compile→auto-update→archive→restore, cap behavior) with acceptance criteria | QA | P3, P4 |
| P6 | Docs polish + agent-authoring hardening (agents creating/updating cards via API) — optional fast-follow | CodexCoder | P5 |

## 10. Open questions for the board

1. **Default policy** — propose new cards default to **manual + stale indicator** (spends nothing until opted in). OK, or default to 15-min change-gated?
2. **Model tiering** — keep everything on the Summarizer's default haiku-class model in v1 (uniform + cheap), or use a bigger model for full rebuilds?
3. **Sharing scope** — v1: one shared company board, any board user can create/edit. Private per-user boards later?
4. **Reactive floor** — is 60s debounce + 6/hr cap the right ceiling, or do you want a "fastest" preset closer to per-minute?
5. **Event-driven fast path** — v1 watches via scheduler ticks (simple, restart-safe). If reactive cards need <30s reaction, we'd add an activity-log listener keyed on the card's project ids as an optimization. Defer?
6. **Agent-created cards** — API supports agent authorship from day one, UI hides it in v1. OK?
