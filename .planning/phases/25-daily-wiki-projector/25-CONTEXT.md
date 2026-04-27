# Phase 25: Daily Wiki Projector - Context

**Gathered:** 2026-04-27
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 25는 board event(todo.created, todo.updated, todo.moved, task.completed 등)를 자동으로 daily wiki page로 변환하는 projector를 구현한다. 사용자는 날짜별 위키 페이지, index.md(날짜 카탈로그), log.md(연속 활동), per-user daily page를 조회할 수 있다. projector는 replay-safe하고 idempotent하며 `appendAndProject()`를 통해 knowledge_core chain에 연결된다.

</domain>

<decisions>
## Implementation Decisions

### Daily Page Structure
- **D-01:** Cumulative `index.md`와 `log.md`는 기존 Phase 5 knowledge projector가 생성한다. Phase 25는 날짜별 daily wiki page를 새로 추가한다.
- **D-02:** daily wiki page는 company-scoped로, `rt2_v33_daily_wiki_pages` 테이블에 저장한다 (기존 `rt2_v33_wiki_pages`와는 별도 테이블).
- **D-03:** daily page의 `pageKey` 형식: `daily/YYYY-MM-DD.md` (전체 events), `daily/YYYY-MM-DD/user/{userId}.md` (per-user).

### Event Coverage
- **D-04:** projector는 다음 event type을 처리한다: `rt2.todo.created`, `rt2.todo.started`, `rt2.execution.claimed`, `rt2.execution.started`, `rt2.execution.completed`, `rt2.execution.failed`.
- **D-05:** todo.moved는 `rt2.todo.started`로 처리 (column 이동 event type 없음 — moved는 start의 state transition으로 modeling).

### Replay-Safety and Idempotency
- **D-06:** projector는 `processEvent(projectorName, eventId, handler)` contract를 사용한다 — 이미 processed된 event는 skip한다.
- **D-07:** idempotency는 `(companyId, reportDate, userId)` unique constraint로保証 — 같은 날짜/사용자 page는 upsert한다.
- **D-08:** page content는 eventline을 append-only로 추가한다. 이미 추가된 eventId는 필터링해서 중복을 방지한다 (`sourceEventIds` tracking).

### UI Access
- **D-09:** `GET /companies/:companyId/rt2/knowledge/daily?date=YYYY-MM-DD` — 전체 daily page 조회.
- **D-10:** `GET /companies/:companyId/rt2/knowledge/daily?date=YYYY-MM-DD&userId=xxx` — per-user daily page 조회.
- **D-11:** `GET /companies/:companyId/rt2/knowledge/daily/index` — date-catalog (모든 daily page 목록).

### Agent Discretion
- markdown rendering format (event line 형식, frontmatter 포함 여부)
- page summary 생성 방식
- activity entry granularity (event type별 다르게 표시 여부)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase Context
- `.planning/phases/05-wikillm-and-graphify-knowledge-core/05-CONTEXT.md` — cumulative wiki pages, topic pages, projector contract, replay-safe rules.
- `.planning/phases/21-obsidian-bidirectional-knowledge-sync/21-CONTEXT.md` — vault settings, source-of-truth semantics.
- `.planning/PROJECT.md` — RT2-first identity, knowledge projection principles.
- `.planning/ROADMAP.md` — Phase 25 goal and success criteria.
- `.planning/REQUIREMENTS.md` — WIKI-01 ~ WIKI-05 requirements.

### Existing Code
- `server/src/services/rt2-domain-events.ts` — `appendAndProject()` calls `rt2KnowledgeProjectorService(db).projectEvent(event.id)`, processEvent idempotency by (projectorName, eventId).
- `server/src/services/rt2-knowledge-projector.ts` — existing `projectWikiForCompany()` creates index/log/topic, `projectEvent()` wraps `processEvent`, projector name `rt2.knowledge_core`.
- `packages/db/src/schema/rt2_v33_daily_wiki_pages.ts` — existing daily wiki table with `companyId, projectId, userId, reportDate, pageKey, markdown, history`.
- `packages/db/src/schema/rt2_v33_wiki_pages.ts` — cumulative wiki pages table.
- `packages/shared/src/types/rt2-domain-events.ts` — event type definitions: `rt2.todo.created`, `rt2.todo.started`, `rt2.execution.claimed`, `rt2.execution.started`, `rt2.execution.completed`, `rt2.execution.failed`.
- `server/src/routes/rt2-knowledge.ts` — existing knowledge routes.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `rt2KnowledgeProjectorService.projectEvent()` — already handles projector idempotency via processEvent. Phase 25 can call this or extend it.
- `rt2_v33_daily_wiki_pages` table — already exists with company/project/user/date/pageKey/markdown/history columns. Can store daily wiki content.
- `processEvent(projectorName, eventId, handler)` — projector event tracking prevents duplicate processing.

### Established Patterns
- Company-scoped routes use `assertCompanyAccess`.
- Wiki page upserts use `onConflictDoUpdate` with company+pageKey target.
- Activity logging captures domain events for history.

### Integration Points
- `appendAndProject()` in rt2-domain-events.ts triggers `projectEvent()` — Phase 25 daily projector can hook into same flow.
- Existing knowledge routes (`GET /knowledge/wiki-pages`) can be extended with daily wiki endpoints.
- Phase 25's daily wiki projector runs on top of existing `rt2KnowledgeProjectorService` — not a separate service.

</code_context>

<specifics>
## Specific Ideas

- Phase 5의 `projectWikiForCompany()`가 cumulative index/log/topic을 생성하고, Phase 25는 date-indexed daily page를 추가한다 — 둘은互补한다.
- daily wiki page의 markdown은 event line format: `- {timestamp} {eventType} {entityType}:{entityId} actor={actorType}:{actorId}`.
- per-user daily page는 userId filter로 동일한 format이지만 actor로 filter된 events만 포함한다.

</specifics>

<deferred>
## Deferred Ideas

- Phase 26 (Graphify)가 daily wiki content를 읽어서 knowledge graph을 생성한다 — daily page가 graph의 source가 된다.
- Phase 29 (Linting)가 nightly로 wiki content를 스캔해서 contradictions을 탐지한다 — batch scan이므로 on-write trigger 없음.

---

*Phase: 25-daily-wiki-projector*
*Context gathered: 2026-04-27*