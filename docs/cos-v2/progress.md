# COS v2 — Progress

> 마지막 업데이트: 2026-04-09
> 세션 재시작 시 이 문서 + `CONTEXT.md` + `phase4-cli-design.md` 먼저 읽을 것.

---

## 현재 상태 한눈에

| 영역 | 상태 |
|------|------|
| **Phase 1** Teams + Workflow + Sub-agents | ✅ 완료 (hardened) |
| **Phase 2** Multi-team projects + milestones + health | ✅ 완료 (hardened) |
| **Phase 3a/b** Mission rooms 백엔드 + UI | ✅ 완료 (hardened) |
| **Phase 3c** Realtime (WS push) | ⏸ 연기 — 300ms polling로 동작 중 |
| **팀 구조 재설계** Linear 패턴 (Issues/Projects/Docs + "…" 메뉴) | ✅ 완료 |
| **팀 문서(.md)** Wiki per team | ✅ 완료 |
| **Phase 4** Leader CLI 프로그래매틱 관리 (PM2 + MCP channel-bridge + SSE) | ✅ **완료** — infra/보안 hardened, 62/62 검증 통과 |
| **Phase 5** Claude prompt tuning + Cycles + GitHub PR + 채용 에이전트 | ⏳ 시작 안 함 |

---

## 커밋 시퀀스 (중요 커밋만)

| Commit | 내용 |
|--------|------|
| `0016414f` | Phase 1 초기 (teams, workflow, sub-agents) |
| `c299e5e4` | Phase 1 hardening (P0×2 + P1×3) |
| `c356f5d2` | Phase 2 (multi-team projects, milestones, health) |
| `4f8c2a48` | Phase 2 hardening (P0×3 + P1×1) |
| `8495b859` | Phase 2 UI panel |
| `6dcafc0f` | Phase 3a/b (mission rooms backend + UI) |
| `c17aa13e` | Phase 3 hardening (P0×5 + P1×1) |
| `d0571ca3` | 300ms polling (3초 → 300ms) |
| `5f87aef4` | Rooms file/image attachments |
| `35f956ef` | Chat UI redesign (1차: bubbles + grouping) |
| `233862f9` | Chat UI Slack 패턴 (all-left, right-align 제거) |
| `de529c73` | 1차 team flicker attempt (keepPreviousData) |
| `37cde002` | Chevron 오른쪽 이동 |
| `12339bcd` | **Team flicker 진짜 fix — BOARD_ROUTE_ROOTS 등록** |
| `bf944b27` | 팀 구조 재설계 (Issues/Projects/Settings sub-menu) |
| `5b4d83c8` | Settings → "…" 컨텍스트 메뉴 (Linear 패턴) |
| `dd4336cc` | Issue identifier regex (숫자 포함 팀 prefix 지원) |
| `d0563538` | 팀 context 유지 (Issues 메뉴 active 문제 + 팀 Issues 하이라이트) |
| `0c161ae8` | 팀 settings CRUD editor (workflow + members) |
| `9dde35e4` | 팀 문서(.md) 기능 (team_documents + UI) |
| `d505f327` | 팀 문서 WYSIWYG 에디터 (MDXEditor로 textarea 교체) |
| `a58e7d3a` | Agent detail "Teams" 섹션 (멤버십 + 역할 + 팀 링크) |
| `f417e8dc` | Org chart — 에이전트 카드에 팀 색 도트 + 식별자 + lead 마커 |
| `06fb2a6c` | Phase 4 prep — 리더 전용 aggregated team-instructions 엔드포인트 + UI 프리뷰 |
| `5628eb0f` | Phase 4 — action execution 경화 (Codex #11/#12): FOR UPDATE 락 + true idempotency + result/error/audit 컬럼 |
| **Phase 4 본체 (4b~4n, 14 커밋)** | Leader CLI 프로그래매틱 관리 전체 — stream-bus/room-stream-bus/agent-stream-bus/SSE endpoint/leaderProcessService/PM2 backend/WorkspaceProvisioner/channel-bridge-cos package/CLI routes/UI card/reconcile |
| `f03512a7` | 4b generic StreamBus primitive + plugin-stream-bus adapter 리팩터 |
| `1066b19a` | 4c room + agent stream buses + roomService publish 훅 |
| `1bd15dd2` | 4e migrations 0064/0065 + schemas + validators |
| `c81acb29` | 4f/4g agentSessionService + leaderProcessService skeleton + FakeProcessBackend |
| `3446b73b` | 4h Pm2ProcessBackend 구현 |
| `625291c7` | 4i WorkspaceProvisioner |
| `56d2f3fd` | 4d/4k/4j SSE endpoint + CLI routes + channel-bridge-cos package |
| `bdb8e3be` | 4n app.ts wiring + reconcile + agent delete cascade |
| `0bdb2b37` | 4l Agent Detail CLI Process 카드 |
| `58cc8b1e` | 4m PTY runner shim + claude binary resolution |
| `e312167c` | **Phase 4 review — feature-dev reviewer 8 P0/P1 fix** |
| `d4a94c44` | **Phase 4 review — codex 적대적 챌린지 9 fix** |
| `7b761b53` | **Phase 4 E2E verification — 2 fix (SSE μs precision + pty-runner env allowlist)** |

---

## Phase 1 — ✅ 완료

### 9개 sub-unit 모두 통과

| Unit | 내용 | 비고 |
|------|------|------|
| 1a Fork + 클린 환경 | BBR company, embedded PG | Port 3101 (worktree config) |
| 1b 팀 스키마 + API | `teams`, `team_members`, 7 endpoints | identifier unique per company |
| 1c 팀 UI | Sidebar TEAMS section + detail | `/teams/new`, `/teams/:teamId` |
| 1d 워크플로우 상태 | `team_workflow_statuses`, 5개 auto-seed, slug immutable | category enforce |
| 1e 이슈 팀 귀속 | `issues.team_id`, ENG-42 identifier, per-team counter | atomic `UPDATE counter + 1` |
| 1f Labels 확장 | labels.team_id, parent_id | workspace/team scope + groups |
| 1g Issue Relations | type 확장 (blocks\|related\|duplicate), 스키마 변경만 | service 코드는 "blocks" 하드코딩 남음 |
| 1h Estimates | issues.estimate + teams.settings JSONB | |
| 1i 시드 + 서브에이전트 | `scripts/seed-cos-v2.ts` (idempotent) | 10 teams + 7 leaders + 11 sub-agents |

### Phase 1 Hardening

코드 리뷰(`feature-dev:code-reviewer` + `/codex challenge`)에서 발견 → fix:

| # | Severity | Issue | 발견자 |
|---|----------|-------|--------|
| 1 | P0 | Cross-tenant agent metadata leak (3 벡터: addMember/PATCH lead/POST team) | Codex |
| 2 | P0 | Per-team counter race (`SELECT max() + UPDATE` READ COMMITTED race) | code-reviewer (95%) |
| 3 | P1 | Status validation create-only (update path 우회) | code-reviewer (90%) |
| 4 | P1 | `teams.update()` non-atomic (lead demote/promote 3단계) | code-reviewer (85%) |
| 5 | P1 | `removeMember` missing teamId scope check | code-reviewer (85%) |

모두 atomic `UPDATE counter + 1`, `assertAgentInCompany`, `db.transaction` + row lock, `WHERE id AND team_id`로 해결. `team_members.company_id` FK 컬럼도 마이그레이션 0057로 추가.

### 마이그레이션 목록
- 0053 `cos_teams.sql` — teams + team_members
- 0054 `cos_workflow_statuses.sql`
- 0055 `cos_issue_team.sql` — issues.team_id
- 0056 `cos_labels_relations_estimates.sql` — labels.team_id/parent_id, issues.estimate, teams.settings
- 0057 `cos_team_members_company.sql` — hardening (cross-tenant fix)

---

## Phase 2 — ✅ 완료

### 4개 영역

| 영역 | 테이블 | 엔드포인트 |
|------|--------|-----------|
| Multi-team projects (N:M) | `project_teams` | GET/POST/DELETE |
| Project members | `project_members` | GET/POST/DELETE |
| Milestones | `project_milestones` + `issues.milestone_id` | GET/POST/PATCH/DELETE |
| Health updates | `project_updates` + denormalized `projects.health` | GET/POST |
| Filters | - | `projects?teamId=`, `issues?milestoneId=` |

### Phase 2 UI Panel
`ui/src/components/ProjectPhase2Panel.tsx` — project overview 탭에 4개 섹션 (Teams/Members/Milestones/Health), 헤드 Chrome으로 10개 시나리오 검증 완료.

### Phase 2 Hardening

| # | Severity | Issue | 발견자 |
|---|----------|-------|--------|
| 1 | P0 | `milestoneId` no cross-project/company scope on issue create/update | Codex + code-reviewer |
| 2 | P0 | `addMember` userId path not validated (projectExtras) | Codex + code-reviewer |
| 3 | P0 | (Phase 1 잔여) `teamService.addMember` userId path도 같은 문제 | self-audit |
| 4 | P1 | `createUpdate` health denormalization race (blind UPDATE) | code-reviewer (88%) |
| 5 | - | `removeMilestone` not scoped to projectId | self-audit |

Fix: 모든 cross-tenant 검증을 `assertEntityInCompany` 헬퍼로 통일, health UPDATE에 monotonic guard (`WHERE healthUpdatedAt IS NULL OR <= now`), milestone scope 검증 (same company AND same project).

### 마이그레이션
- 0058 `cos_phase2_projects.sql` — 4 tables + `issues.milestone_id` + `projects.health`/`health_updated_at`

---

## Phase 3a/b — ✅ 완료 (Mission rooms + 채팅 UI)

### Phase 3a 백엔드

| 테이블 | 내용 |
|--------|------|
| `rooms` | name/description/status/creator, company-scoped |
| `room_participants` | role: owner\|member, cross-tenant 검증 |
| `room_messages` | type: text\|action\|status\|system, action_status, attachments JSONB |
| `room_issues` | N:M link to issues |

14개 REST 엔드포인트. `roomService`가 transaction wrap + cross-tenant 검증 (sender, action target, reply-to scope, participant agent/user, issue, room).

### Phase 3b UI
- `SidebarRooms` — rooms list (3초 polling)
- `/rooms/new`, `/rooms/:roomId`
- 메시지 패널 + 참여자 사이드바 + linked issues
- **Slack/Mattermost 패턴**: all-left, avatar + name + timestamp 그룹 헤더, 연속 메시지 grouping, action 메시지 emerald/amber/red 박스
- File/image 첨부 (drag & drop + clipboard paste + file picker)

### 300ms polling (Phase 3c 대체)
`refetchInterval: 300` — chat-like UX, avg 150ms / worst 300ms visibility, 20 viewer load 테스트 통과. WS push는 Codex 리뷰에서 **2개 high risk** 지적 (privacy fan-out + multi-process backplane) 해서 **Phase 4 (PM2 + CLI)와 같이 결정**하기로 연기.

### Phase 3 Hardening (P0×5 + P1×1)

| # | Severity | Issue |
|---|----------|-------|
| 1 | P0 | 룸 멤버십 미검증 — company 멤버 누구나 private room 접근 |
| 2 | P0 | Room list가 non-member에게 이름 누출 (self-discovery during verify) |
| 3 | P0 | Action status 인가 없음 (non-target이 executed로 전환) |
| 4 | P0 | Transition guard 없음 (executed → pending 회귀 가능) |
| 5 | P0 | Creator userId path 미검증 |
| 6 | P1 | `room_participants` duplicate user rows (partial unique index 없음) |

Fix: `assertRoomParticipant()` helper + 모든 room-scoped route에 `loadRoomForAccess()` wrapper, `updateActionStatus`에 target/owner 권한 + terminal state guard, `createUpdate`에 monotonic guard, `room_participants_room_user_uniq` partial unique index.

### 마이그레이션
- 0059 `cos_phase3_rooms.sql`
- 0060 `cos_phase3_hardening.sql` — partial unique index
- 0061 `cos_room_attachments.sql` — room_messages.attachments JSONB

---

## 팀 구조 재설계 (Linear 패턴)

사용자가 Linear 스크린샷으로 지적한 대로 완전 재설계:

### 변경
- **팀 클릭 → `/teams/:id/issues` 리다이렉트** (`TeamIndexRedirect`)
- **팀 sub-menu**: Issues / Projects / **Docs** (Settings는 sub-menu에서 제거)
- **"…" context menu** (hover 시 등장): Team settings / Copy link / Open archive
- **Chevron**: 이름 바로 옆 (우측 끝 아님)
- **TeamSettingsPage 분리** — `/teams/:id/settings`로 이동

### 3개 팀 페이지
- `TeamIssuesPage` — 기존 `IssuesList` 컴포넌트 재사용 + `teamId` 필터
- `TeamProjectsPage` — `EntityRow` + `StatusBadge` 재사용 + `teamId` 필터
- `TeamSettingsPage` — 워크플로우 + 멤버 CRUD 에디터

### 팀 Settings CRUD UI
- **`WorkflowStatusesEditor`** — Add / rename / recolor / set default / delete, inline edit with color picker
- **`TeamMembersEditor`** — Agent picker (company 내 not-yet-member) / Make lead / remove, 서버 transaction으로 lead 동기화

### 핵심 버그 fix 2건
1. **팀 클릭 시 전체 화면 flicker** — 근본 원인은 `ui/src/lib/company-routes.ts`의 `BOARD_ROUTE_ROOTS` 세트에 `teams`, `rooms`가 **없어서** NavLink → `/teams/...` → `UnprefixedBoardRedirect` 2-hop → Layout 재마운트. **한 줄 fix**로 해결 (등록). `keepPreviousData`/`placeholderData`는 데이터 레이어 workaround였고 근본 원인 아니었음.
2. **이슈 클릭 시 "Issue not found"** — 식별자 regex `/^[A-Z]+-\d+$/i`가 **문자만 허용**. Phase 1에서 팀 identifier에 숫자 허용(`ENG2`, `PLT3`)했지만 이 3개 파일의 regex는 안 바꿨음 (`issues.ts`, `agents.ts`, `activity.ts`). 모두 `/^[A-Z][A-Z0-9]*-\d+$/i`로 수정.

### 이슈 클릭 시 팀 context 유지
`SidebarTeams`가 현재 URL이 issue detail이면 이슈 fetch → teamId 추출 → 매칭 팀의 Issues sub-item `forceActive`. Global Issues는 `end` prop으로 exact match만 active.

---

## 팀 문서 (.md) — Wiki per team

company-os v1의 `agents/cos-hq.md`, `agents/RULES.md`, `company/areas/own-services/flotter/README.md` 같은 팀별 markdown 문서를 Linear 팀 wiki처럼 지원.

### 아키텍처
- **테이블**: `team_documents` join (teamId + documentId + key), 기존 `documents` + `document_revisions` 재사용
- **Unique**: `(company_id, team_id, key)` — 팀 내 slug 유일
- **Revision history**: documents 테이블의 revision 인프라 그대로 활용
- **Optimistic concurrency**: `baseRevisionId` 기반 — 두 탭 동시 편집 시 뒤쪽은 409 + `currentRevisionId` 반환

### REST
- `GET / PUT / DELETE /companies/:cid/teams/:tid/documents[/:key]`
- `GET .../documents/:key/revisions`

### UI
- 사이드바 팀 sub-menu에 **Docs** 추가 (Issues / Projects / Docs)
- `TeamDocsPage` — 문서 list + New doc (title + slug)
- `TeamDocDetailPage` — title input + markdown textarea + Save/Delete, revision number 표시

### 마이그레이션
- 0062 `cos_team_documents.sql`

---

## Phase 4 — ✅ 완료 (Leader CLI 프로그래매틱 관리)

> 설계 문서: `docs/cos-v2/phase4-cli-design.md` (v2, 17 약점 자체 비판 후 전면 재작성)

### 목표 달성

조직(company/team/leader agent)이 UI로 자유롭게 추가·변경·삭제되어도,
**셸 스크립트 수정·`.mcp.json` 수동 편집·PM2 config 편집 없이** 리더 CLI의
전체 라이프사이클(provision → start → run → stop → cleanup)이 서버가 DB
상태로부터 자동 관리된다.

### 아키텍처

```
COS v2 Server (3101)
├─ StreamBus primitive (lib) — 일반 pub/sub, plugin/room/agent 어댑터가 공유
├─ leaderProcessService — 상태 머신 + per-agent async-mutex + bidirectional reconcile
├─ agentSessionService — 에이전트당 active session 1개 (partial unique index)
├─ WorkspaceProvisioner — ~/.cos-v2/leaders/<slug>/ 생성 + .mcp.json + 키 발급
├─ Pm2ProcessBackend — pm2 programmatic API, pty-runner wrapping, instance-scoped names
├─ FakeProcessBackend — 테스트 전용
├─ SSE endpoint GET /agents/:aid/stream?since= — cursor replay + race-window dedup
├─ /cli/start|stop|restart|status|logs routes — board 전용
├─ /leader-processes admin list
├─ Agent delete beforeDelete hook → cascade stop + workspace cleanup
└─ 30s periodic reconcile (setInterval)

packages/channel-bridge-cos/ — 새 monorepo package (tsx 직접 실행)
├─ env.ts — fail-fast validation
├─ state.ts — <workspace>/state.json atomic cursor
├─ sse-client.ts — EventSource + Bearer + backoff + serialized handler chain
├─ instructions.ts — /team-instructions fetch → MCP instructions 필드
└─ index.ts — MCP stdio server + reply/edit_message tools + self-loop filter
                + message_id → room_id LRU map (cross-room leak 방지)

server/src/services/pty-runner.cjs — PM2 → claude CLI 사이의 pty 쉼
(claude 가 interactive channel mode에 들어가려면 TTY 필수; PM2 파일 파이프
로는 --print fallback + 실패. node-pty로 xterm-256color 할당. pattern-
based auto-Enter 로 workspace trust + dev channels 동의 프롬프트 자동 수용)
```

### DB (migrations 0064, 0065)

- `leader_processes` — intent + history (status, pm2_name, pid, session_id,
  agent_key_id, started_at/stopped_at, exit_code, error_message). UNIQUE(agent_id).
- `agent_sessions` — 에이전트당 durable CLI session 컨텍스트 (workspace_path 안정 →
  Claude `~/.claude/projects/<hash(cwd)>/` 자동 복원). Partial unique index
  `one_active_per_agent`.

### 핵심 결정사항

1. **PM2 programmatic API** (프로덕션 backend 단일화) — logrotate, crash restart,
   리소스 제한 모두 위임. DetachedSpawn은 제거, `Pm2ProcessBackend` + 테스트용
   `FakeProcessBackend` 둘만.
2. **Agent-scoped SSE stream** (not room-scoped) — 룸 멤버십 변경 자동 반영,
   "수동 restart" 금지.
3. **SSE cursor ?since=<messageId>** — μs precision 이슈는 id-기반 app-layer
   filter 로 방어. 재연결 중복 0.
4. **message_id → room_id LRU map** (bridge) — `lastReceivedRoomId` 단일 변수
   대신 LRU. 다른 룸 메시지가 중간에 끼어들어도 `reply`는 올바른 룸으로.
5. **session ≠ agent** — 재시작해도 Claude 컨텍스트 보존. workspace_path 안정.
6. **Instance-scoped PM2 prefix** `cos-<instanceId>-<agentId>` — 같은 머신에
   여러 worktree가 있어도 reconcile 서로 간섭 없음.
7. **env allowlist (two-layer)** — workspace-provisioner + pty-runner 양쪽
   모두 PATH/HOME/COS_* 만 통과. `...process.env` spread 금지.
8. **Per-agent async-mutex** — start/stop 레이스 직렬화. restart는 single
   mutex acquire 로 doStop+doStart 원자화.
9. **Periodic reconcile 30s** — 런타임 crash 감지. startup-only reconcile는
   서버 부팅 후 일어나는 crash를 놓침.
10. **Self-loop guard 이중** — bridge가 `senderAgentId === self` 필터 + 서버가
    `is_bot` 메타 표시.

### 리뷰 + hardening (3 pass)

| # | Pass | 발견 |
|---|---|---|
| 1 | feature-dev:code-reviewer | **8 P0/P1**: ensureConnected TOCTOU race, SSE UUID lexicographic dedup 버그, restart() mutex 갭, env leak, pm2 8-char 충돌, pty-runner 무조건 Enter, destroyForAgent 갭, /cli/status 비-board 접근 — 전부 commit `e312167c` 에서 fix |
| 2 | /codex challenge (gpt-5-codex --xhigh) | **9 P0/P1**: reply() cross-room leak, named SSE events dropped, message.updated dedup drop, stop() false positive, team-instructions cross-agent read, PM2 instance collision, reconcile 전이 오진, periodic reconcile 없음, bridge concurrent handler race — 전부 commit `d4a94c44` 에서 fix |
| 3 | E2E verification 중 발견 | **2 fix**: SSE cursor μs precision (Postgres timestamp 6자리 vs JS Date 3자리) + pty-runner가 `...process.env` spread 했던 이슈 — commit `7b761b53` |

### 검증 결과 (62/62 PASS)

- **Unit tests**: 40/40 (stream-bus, plugin/room/agent bus 어댑터, leaderProcessService invariants I1-I8 + S1-S4)
- **Regression**: room CRUD + action message 경화 (5628eb0f) 동작 유지
- **SSE stream**: initial sync, default event channel, cursor resume (zero dup), message.updated dedup
- **Security**: requireBoard on /cli/status+logs, cross-agent team-instructions refused, file perms 0600/0700, env allowlist (claude child env 키 확인)
- **PM2**: instance-scoped prefix `cos-default-*`, cross-instance isolation (다른 prefix 프로세스 생존)
- **Periodic reconcile**: `kill -9` → 30~35s 내 DB `running → crashed` 전이
- **Browser E2E**: CLI Process 카드 렌더, Start/Stop/Restart 버튼 동작, live log tail SSE, 룸 메시지 POST

### 알려진 한계 (Phase 5 후속)

- **Claude behavioral tuning** — `reply` tool 호출 유도는 instructions prompt engineering 영역. 이 단계에서는 "Cyrus가 답장을 할지" 까지 보증 안 함. Channel notification이 Claude 세션에 정확히 들어가는 것까지만 증명.
- **PM2 daemon env leak** — `pm2 jlist` 는 서버 env 172키를 그대로 보여줌. claude child는 allowlist로 clean하지만, pm2 record 자체 격리는 daemon 수준 작업 필요.
- **SSE 1000-cap replay** — 긴 disconnect 후 재연결 시 룸당 최대 1000개 메시지. Cursor는 복원되지만 그 이전 window는 lost. pagination 필요.

### 파일 변경

14 커밋, 약 3500+ 줄 추가. 기존 코드 수정은 `plugin-stream-bus.ts` 내부 리팩터
(public API 불변) + `rooms.ts` publish 훅 추가 + `agents.ts` beforeDelete hook +
`app.ts` DI 와이어링이 전부. Breaking change 0.

---

## 사용자 feedback (memory 저장됨)

`~/.claude/projects/-Users-bright-Projects-company-os-v2/memory/`

- **Autonomous execution** — 질문 없이 강하게 구현+QA 반복
- **Route patterns** — 새 route는 host router 패턴 그대로, `BOARD_ROUTE_ROOTS` 등록 필수
- **Browser CRUD verification** — API 200 ≠ UI 동작, 헤드 브라우저 클릭 플로우까지 검증

---

## 알려진 향후 작업

| # | 항목 | 우선순위 |
|---|------|---------|
| 1 | `adapter_type=none/sub_agent` 정식 등록 (현재 `process` hack) | 낮음 |
| 2 | `issue_relations.type` 확장 API (related/duplicate 사용) | 낮음 |
| 3 | 이슈 update 시 `status` 검증은 이미 있음 (Phase 1 hardening) | 완료 |
| 4 | 이슈 팀 이동 시 status 리셋 | 낮음 |
| 5 | Instructions 자동 주입 — 엔드포인트 ✅ (`06fb2a6c`), CLI startup 훅만 남음 | Phase 4 |
| 6 | WS 실시간 push (privacy fan-out + pg_notify backplane) | Phase 4와 같이 |
| 7 | Agent detail "Teams" 섹션 + OrgChart 뱃지 ✅ | 완료 |
| 8 | `session` 데이터가 잘못 접근되는 경우 ("Add company" 무작위 포커스) | 낮음 |

---

## 다음 진행 방향 선택지

1. **Phase 4 — CLI + PM2 + action execution** (Codex 이슈 #3, #4, #11, #12 해결)
2. ~~**Agent detail "Teams" 섹션** + OrgChart 뱃지~~ — ✅ 완료 (`a58e7d3a`, `f417e8dc`)
3. **리더 에이전트 instructions 자동 주입** — `/agents/:id/team-instructions` aggregated 엔드포인트 완료 (`06fb2a6c`), UI 프리뷰 포함. CLI startup 훅만 Phase 4에서 남음
4. ~~**Markdown 렌더링**~~ — ✅ 완료 (`d505f327`, MDXEditor로 교체)

---

## 환경 정보

- **Repo**: `/Users/bright/Projects/company-os-v2` (master)
- **Upstream**: Paperclip fork (`paperclipai/paperclip`)
- **Server port**: **3101** (worktree config — `paperclip-worktrees-43xupE/instances/pap-885-show-worktree-banner`)
- **DB**: Embedded PostgreSQL (54330)
- **Company**: BBrightcode Corp (prefix `BBR`, id `d97193bc-976f-401d-bdb6-9741319359d9`)
- **Dev 실행**: `pnpm dev:once`
- **빌드**: `pnpm --filter @paperclipai/shared build && pnpm --filter @paperclipai/db build && pnpm --filter @paperclipai/ui build`
- **재시작**: `pkill -9 -f "tsx.*src/index.ts" && pnpm dev:once > /tmp/paperclip-dev.log 2>&1 &`
- **브라우저 QA**: `~/.claude/skills/gstack/browse/dist/browse` (headed Chrome 유지 중, `$B connect`로 시작)

---

## 세션 재시작 체크리스트

새 세션에서 context가 날아갔으면:

1. `cat docs/cos-v2/progress.md` — 이 문서
2. `cat docs/cos-v2/CONTEXT.md` — 결정사항 + Codex 이슈 백로그
3. `cat docs/cos-v2/phase1-breakdown.md` — 계획
4. `git log --oneline -30` — 최근 커밋
5. `curl -s http://127.0.0.1:3101/api/health` — 서버 상태
6. `ls ~/.claude/projects/-Users-bright-Projects-company-os-v2/memory/` — feedback 기록
7. **다음 작업 결정 후 `/cos-v2` 로 진행**
