# Phase 4 — 리더 CLI 프로그래매틱 관리 설계 (v2)

> 작성: 2026-04-08 · v1 자체 비판 후 전면 재작성
>
> 해결 대상: Codex #3 (PM2 예시 오류), #4 (세션 소유권 미정의)

---

## 1. 문제 진술

조직(company / team / leader agent)은 UI로 자유롭게 추가·변경·삭제된다.
리더 에이전트가 추가될 때마다 사람이:

- 셸 스크립트를 수동 편집하거나
- `.mcp.json` 파일을 손으로 쓰거나
- PM2 config를 편집하거나
- 어디선가 env를 설정한다면

→ **한 스텝 빼먹으면 동작 안 함, 원인 찾기 힘듦.** 설계 실패.

**목표**: 리더 CLI의 전체 라이프사이클(provision → start → run → stop → cleanup)을
서버가 **DB 상태로부터 완전히 프로그래매틱하게** 관리한다. 조직 추가/변경은 UI 클릭만으로
끝난다. 사람이 파일 시스템을 만지거나 외부 데몬을 편집할 일이 없다.

## 2. 비목표 (명시적 배제)

- cmux 통합 (사용자 지시)
- Claude Agent SDK 경로 (사용자 지시 — `claude` CLI 본체를 사용)
- 멀티 호스트 분산 — single-node local-first. 인터페이스만 확장 가능하게 열어둠
- systemd/launchd 통합
- 프로덕션 보안 (JWT rotation 등) — MVP 후속. 로컬 trust mode 전제

## 3. v1 자체 비판 → v2 결정 요약

| # | v1 약점 | v2 결정 |
|---|---|---|
| 1 | DetachedSpawn이 기본, PM2가 future | **PM2 programmatic API = 유일한 production backend.** `ProcessBackend` 인터페이스는 테스트용 `FakeProcessBackend`만 별도 구현 |
| 2 | SSE 재연결 시 메시지 중복 전달 | **`?since=<lastMessageId>` cursor 기반 재생.** 초기 sync와 resume이 동일 메커니즘. 중복 0 |
| 3 | `COS_ROOM_IDS` 스냅샷 → 룸 멤버십 변경 시 수동 restart | **Agent-scoped stream** (`GET /agents/:aid/stream`). 서버가 현재 멤버십으로 동적 fanout. 룸 추가/제거는 0 restart |
| 4 | agent ↔ CLI 1:1 결합 → 재시작마다 컨텍스트 날아감 | **`agent_sessions` 엔티티 분리.** CLI는 session에 바인드. Claude의 `~/.claude/projects/` 디렉토리 기반 복원 활용 |
| 5 | `instructions.md` + `CLAUDE.md` 이중 소스 | **단일 소스**: bridge의 MCP `instructions:` 필드만. 파일 없음 |
| 6 | 자기 메시지 루프 방지 언급 없음 | **명시**: bridge가 `senderAgentId === COS_AGENT_ID` 필터링 + 서비스가 `is_bot` 메타 추가 |
| 7 | Agent key 매번 재발급 → 누적 | **재사용 우선**: 활성 키 있으면 재사용, 없을 때만 신규. Stop 시 revoke 안 함. Agent delete → cascade |
| 8 | Claude channels 기능 자체 설명 누락 | **§4 primer section 신설** |
| 9 | repo source 직접 참조 | **`packages/channel-bridge-cos/`** monorepo package + `tsx` 직접 실행. provision이 매 start마다 절대 경로 재계산 |
| 10 | 수동 log rotation | **PM2 기본 제공** (pm2-logrotate) |
| 11 | start/stop race | **per-agent async-mutex** — start의 spawn 완료까지 stop 대기 |
| 12 | DB-only reconcile (고아 프로세스 탐지 어려움) | **DB ↔ PM2 양방향 reconcile** + FS pid registry 대체 불필요 (PM2가 관리) |
| 13 | single-process 가정 암묵 | **§7에 명시**, StreamBus 확장 포인트 고정 |
| 14 | Test invariants 주장만 | **§18에 invariant 리스트 + test scenario 매핑** |
| 15 | 멀티 리더 룸 semantics 누락 | **§17에 명시** (MVP: 모두 응답 허용, future: @-addressing) |
| 16 | fd leak in spawn backend | PM2가 관리 → 해당 없음 |
| 17 | reconcile vs HTTP accept race | PM2 backend에서는 PM2가 이미 살아있음, 서버 startup은 단순 조회 |

---

## 4. Claude Channels Primer

이 설계의 핵심은 **`claude/channel`** 이라는 Claude Code의 experimental MCP capability다.
채널을 정확히 이해해야 나머지가 이해된다.

### 4.1 일반 MCP 흐름 (기존)

```
Claude CLI  ──MCP stdio──▶  MCP Server
   ▲                         │
   └── tool call response ───┘
   (Claude가 tool 호출 → 서버 응답, 동기)
```

Claude는 **요청자**. 서버는 **응답자**. 서버가 먼저 Claude에게 말하지 못함.

### 4.2 Channel을 쓴 흐름 (신규)

```
Claude CLI (with --dangerously-load-development-channels server:channel-bridge)
   ▲                         │
   │ notifications/claude/channel   │ tool call (reply)
   │ (서버 발신 → Claude 수신)        │
   └─────  MCP Server  ◀─────┘

MCP server는 `capabilities.experimental = { "claude/channel": {} }`를 선언.
그 순간부터 server는 Claude에게 **임의 시점에 notification을 push 가능**.

Claude CLI는 이 notification을 받으면 "사용자가 새 메시지를 보낸 것처럼" 취급하고
다음 턴을 시작한다 — tool 사용, reply 생성 등.
```

**Notification format** (v1 channel-bridge 참조):
```json
{
  "method": "notifications/claude/channel",
  "params": {
    "content": "사용자가 쓴 메시지 본문",
    "meta": {
      "sender": "user-id or agent-id",
      "thread_ts": "",
      "channel": "room-uuid",
      "room_id": "room-uuid",
      "message_id": "msg-uuid",
      "is_bot": "false"
    }
  }
}
```

### 4.3 설계에 주는 시사점

1. **Bridge는 단순한 stdio MCP 서버 + event emitter.** `notifications/claude/channel`을 언제 발사할지만 결정. 발사 후에는 Claude 쪽이 알아서 처리.
2. **Bridge가 Claude에 "다음 턴 해"라고 밀어넣는 방법은 channel notification 뿐**이다. 다른 MCP 메서드 없음. 이 하나에 설계 전부가 의존.
3. **Reply는 별도 tool** (`reply(message, thread_ts?)`) — Claude가 명시적으로 호출해야만 bridge가 `POST /rooms/:rid/messages` 를 실행.
4. 즉, 메시지 수신 → Claude 턴 실행 → reply tool 호출 → HTTP POST 라는 비동기 pipeline이다.

### 4.4 "CLI 플래그" 의미

`--dangerously-load-development-channels server:channel-bridge`:

- `server:channel-bridge` = `.mcp.json`의 `mcpServers.channel-bridge` 엔트리를 가리킴
- 이 flag가 있어야 Claude CLI가 experimental capability `claude/channel`을 **실제로 listen**함
- flag 없으면 MCP server가 capability를 선언해도 Claude CLI는 무시
- 이름이 "dangerous"인 이유: flag는 아직 experimental stage. 프로덕션 보증 없음

---

## 5. 설계 원칙

1. **DB가 유일한 source of truth** (intent + history). PM2는 runtime reality. 두 상태의 차이는 reconcile이 해결.
2. **레이어 분리 + 의존성 역전**. 도메인 서비스는 추상 인터페이스에만 의존. 구현은 생성자 주입.
3. **기존 인프라 재사용**. `plugin-stream-bus.ts` 의 in-memory pub/sub 코어를 일반 `StreamBus` primitive로 추출. 플러그인 시스템과 rooms가 동일 primitive 사용.
4. **아티팩트는 매 start마다 재생성**. `.mcp.json` 등 디스크 파일은 DB 기준으로 rebuild. 사람이 손댄 변경은 다음 start에서 덮어쓰임.
5. **Bridge는 env-driven**. 코드에 회사/팀/룸/에이전트 하드코딩 없음. 한 벌의 bridge 바이너리로 모든 리더가 돌아감. 새 조직 추가가 bridge 재배포를 요구하지 않음.
6. **PM2가 supervisor**. 크래시·재시작·로그 회전·리소스 제한을 위임. 서버는 얇은 컨트롤러.
7. **Agent-scoped 이벤트 스트림**. 룸 멤버십 변경은 자동 반영. "수동 restart" 금지.
8. **Message delivery는 cursor 기반**. `since` 파라미터로 정확히 한 번 전달. SSE reconnect gap 0.
9. **Session ≠ Agent**. 리더 CLI는 session에 바인드. 재시작해도 Claude 컨텍스트 보존.
10. **모든 상태 전이는 관측 가능**. 구조화된 로그 + DB 업데이트 + Activity Log 통합.
11. **테스트 가능**. Invariants 명시 → test scenarios 직결. Fake backend로 spawn 없이 검증.

---

## 6. 아키텍처 레이어

```
┌─────────────────────────────────────────────────────────────────────────┐
│ HTTP Layer                                                                │
│   routes/leader-processes.ts — POST cli/start|stop|restart, GET status   │
│   routes/rooms.ts            — GET /rooms/:rid/stream (SSE)              │
│   routes/agents.ts           — GET /agents/:aid/stream (SSE)             │
│   (validators in shared/validators/)                                      │
└──────────────┬────────────────────────────────────────────────────────┬──┘
               │                                                        │
┌──────────────▼──────────────────┐   ┌─────────────────────────────────▼─┐
│ Domain Services                  │   │ Stream Services                    │
│ leaderProcessService             │   │ roomStreamBus                      │
│   start(agentId)                 │   │   publish(roomId, event)           │
│   stop(agentId)                  │   │   subscribe(roomId, fn)            │
│   restart(agentId)               │   │                                    │
│   status(agentId)                │   │ agentStreamBus (topic = "agent")  │
│   list(companyId)                │   │   publish(agentId, event)          │
│   reconcile()                    │   │   subscribe(agentId, fn)           │
│                                   │   │                                    │
│ agentSessionService (new)        │   │ (both delegate to StreamBus)       │
│   ensureSession(agentId)         │   │                                    │
│   archiveSession(sessionId)      │   │                                    │
│   resume(sessionId)              │   │                                    │
└──┬────────────┬─────────────┬────┘   └─────────────────┬─────────────────┘
   │            │             │                          │
┌──▼────┐  ┌────▼──────┐  ┌───▼──────────┐   ┌───────────▼───────────────┐
│ DB    │  │ workspace │  │ ProcessBackend│   │ lib/stream-bus.ts          │
│ (drizzle)│ Provisioner│  │  (interface) │   │   generic pub/sub          │
│          │            │  │              │   │   keyed by (topic, key)    │
│ leader_  │  creates    │  │ impls:       │   │   subscribers: Map         │
│ processes│  .mcp.json  │  │  Pm2Process  │   │   publish(topic, key, evt) │
│ agent_   │  issues key │  │    Backend   │   │                             │
│ sessions │  (no CLAUDE.│  │  FakeProcess │   │                             │
│          │   md file)  │  │    Backend   │   │                             │
└──────────┘└────────────┘  └──────┬───────┘   └────────────────────────────┘
                                    │
                            pm2 programmatic API
                                    │
                          ┌─────────▼──────────────┐
                          │ pm2 daemon              │
                          │  (separate process,     │
                          │   managed by pm2 npm    │
                          │   package at startup)   │
                          └─────────┬──────────────┘
                                    │
                            child: Claude CLI
                                    │
                          ┌─────────▼───────────────────────────┐
                          │ Claude CLI                           │
                          │   cwd = ~/.cos-v2/leaders/<session>/  │
                          │   env = COS_*                         │
                          │   loads .mcp.json →                   │
                          │     channel-bridge-cos (stdio MCP)    │
                          └─────────┬───────────────────────────┘
                                    │ stdio MCP
                                    ▼
                          ┌──────────────────────────────────┐
                          │ channel-bridge-cos                 │
                          │ (packages/channel-bridge-cos)      │
                          │                                    │
                          │ 1. Stdio MCP server                │
                          │    tools: reply, edit_message      │
                          │    capability: claude/channel      │
                          │                                    │
                          │ 2. SSE client                       │
                          │    EventSource(.../agents/:aid/    │
                          │      stream?since=<cursor>)        │
                          │    → notifications/claude/channel  │
                          │                                    │
                          │ 3. State persistence                │
                          │    <workspace>/state.json           │
                          │    { lastMessageId: "..." }        │
                          │                                    │
                          │ 4. Self-loop filter                 │
                          │    if senderAgentId === self: skip │
                          └────────────────────────────────────┘
```

---

## 7. StreamBus primitive 재사용 (Refactor)

`server/src/services/plugin-stream-bus.ts` 의 in-memory pub/sub 코어를
**generic `StreamBus`** 로 추출. PluginStreamBus와 신규 Room/Agent StreamBus가 동일 primitive 위의 thin adapter.

### 7.1 새 파일: `server/src/lib/stream-bus.ts`

```ts
export type StreamBusEventType = "message" | "open" | "close" | "error";
export type StreamBusListener<E> = (event: E, meta: { type: StreamBusEventType }) => void;

export interface StreamBus {
  subscribe<E>(topic: string, key: string, listener: StreamBusListener<E>): () => void;
  publish<E>(topic: string, key: string, event: E, type?: StreamBusEventType): void;
  /** Observability: per-(topic,key) subscriber count. */
  stats(): { topic: string; key: string; count: number }[];
  /** Tests only. */
  clear(): void;
}

export function createStreamBus(): StreamBus { /* Map<string, Set<Listener>> */ }
```

**Single-process 전제**. 멀티 프로세스 확장 시 이 모듈만 pg_notify 구현으로 교체. 인터페이스 불변.

### 7.2 `plugin-stream-bus.ts` → thin adapter

```ts
export function createPluginStreamBus(base: StreamBus = createStreamBus()): PluginStreamBus {
  return {
    subscribe(pluginId, channel, companyId, listener) {
      const key = `${pluginId}:${channel}:${companyId}`;
      return base.subscribe("plugin", key, (evt, meta) => listener(evt, meta.type));
    },
    publish(pluginId, channel, companyId, event, eventType = "message") {
      const key = `${pluginId}:${channel}:${companyId}`;
      base.publish("plugin", key, event, eventType);
    },
  };
}
```

기존 플러그인 시스템 동작 **0 변경**. 기존 테스트 그대로 통과.

### 7.3 신규: `room-stream-bus.ts`, `agent-stream-bus.ts`

```ts
// server/src/services/room-stream-bus.ts
export type RoomStreamEvent =
  | { type: "message.created"; message: RoomMessageRecord }
  | { type: "message.updated"; message: RoomMessageRecord }
  | { type: "participant.joined"; participant: RoomParticipantRecord }
  | { type: "participant.left"; participantId: string };

export interface RoomStreamBus {
  subscribe(roomId: string, listener: (e: RoomStreamEvent) => void): () => void;
  publish(roomId: string, event: RoomStreamEvent): void;
}

// server/src/services/agent-stream-bus.ts
export type AgentStreamEvent =
  | { type: "message.created"; roomId: string; message: RoomMessageRecord }
  | { type: "membership.changed"; rooms: string[] }
  | { type: "instructions.updated"; markdown: string };

export interface AgentStreamBus {
  subscribe(agentId: string, listener: (e: AgentStreamEvent) => void): () => void;
  publish(agentId: string, event: AgentStreamEvent): void;
}
```

**둘 다 같은 `StreamBus` 인스턴스 위에 올라감**. `app.ts`에서 한 번 생성해 주입:

```ts
const streamBus = createStreamBus();
const pluginStreamBus = createPluginStreamBus(streamBus);
const roomStreamBus = createRoomStreamBus(streamBus);
const agentStreamBus = createAgentStreamBus(streamBus);
```

### 7.4 Fanout 관계

```
roomService.createMessage(roomId, ...):
  1. insert row
  2. roomStreamBus.publish(roomId, { type: "message.created", message })
  3. 각 participant agent에 대해 agentStreamBus.publish(agentId, { type: "message.created", roomId, message })
```

Bridge는 **agent stream만 구독**. 룸 단위 브로드캐스트는 SSE 엔드포인트 확장성 (관리자 뷰 등) 용도로 유지.

---

## 8. Message Delivery Protocol (신규)

v1 설계의 치명적 구멍 — 재연결 시 중복 전달 — 을 해결한다.

### 8.1 Cursor 기반 정확히 한 번 전달

**원칙**: Bridge는 "마지막으로 Claude에게 전달한 메시지 id"를 workspace의 `state.json`에 persist. 재연결 시 이 cursor로 resume.

### 8.2 SSE 엔드포인트 계약

```
GET /api/companies/:cid/agents/:aid/stream?since=<message-id>
Authorization: Bearer <agent-key>

응답 (SSE):
: ok

id: <message-id>
event: message
data: {"type":"message.created","roomId":"...","message":{...}}

id: <message-id>
event: message
data: {...}

:keepalive

...
```

### 8.3 서버 로직

```ts
app.get("/api/companies/:cid/agents/:aid/stream", async (req, res) => {
  const { cid, aid } = req.params;
  const since = req.query.since as string | undefined;

  // 인증: Bearer agent key (기존 middleware)
  // 인가: aid === req.actor.agentId && company match
  assertOwnAgent(req, aid, cid);

  // SSE 헤더
  writeSseHeaders(res);

  // 1. Replay phase — DB에서 since 이후 메시지 가져와 순서대로 전송
  const backlog = since
    ? await messageService.listForAgentSince(aid, cid, since)  // created_at > cursor.created_at
    : await messageService.listForAgentRecent(aid, cid, 100);

  for (const msg of backlog) {
    writeSseEvent(res, {
      id: msg.id,
      event: "message",
      data: { type: "message.created", roomId: msg.roomId, message: msg },
    });
  }

  // 2. Live subscribe — replay 완료 후 신규 이벤트 push
  const unsub = agentStreamBus.subscribe(aid, (evt) => {
    if (!res.writable) { unsub(); return; }
    if (evt.type === "message.created") {
      writeSseEvent(res, {
        id: evt.message.id,
        event: "message",
        data: evt,
      });
    } else {
      writeSseEvent(res, { event: evt.type, data: evt });
    }
  });

  // 3. Keepalive
  const keepalive = setInterval(() => res.write(":keepalive\n\n"), 15000);

  req.on("close", () => { clearInterval(keepalive); unsub(); });
});
```

### 8.4 Race window 처리

Replay phase ↔ Live subscribe 사이 window에서 도착한 메시지 처리:

```ts
// Buffer during replay, flush after
const buffer: AgentStreamEvent[] = [];
let replaying = true;

const unsub = agentStreamBus.subscribe(aid, (evt) => {
  if (replaying) { buffer.push(evt); return; }
  writeSseEvent(res, { ... });
});

// Do replay
for (const msg of backlog) { writeSseEvent(res, {...}); }

// Flush buffered live events that are AFTER the last replayed id
const lastReplayedId = backlog[backlog.length - 1]?.id;
replaying = false;
for (const evt of buffer) {
  if (lastReplayedId && evt.message.id <= lastReplayedId) continue;  // dedup
  writeSseEvent(res, { ... });
}
```

**`listForAgentSince` 구현**: `room_messages JOIN room_participants WHERE participant.agentId = ? AND company_id = ? AND created_at > (SELECT created_at FROM room_messages WHERE id = ?) ORDER BY created_at ASC LIMIT 1000`. 1000 초과 시 최신 1000개만 + `event: truncated` notice.

### 8.5 Bridge side

```ts
// packages/channel-bridge-cos/src/state.ts
interface BridgeState {
  lastMessageId: string | null;
}

const statePath = path.join(process.env.COS_WORKSPACE!, "state.json");
const state: BridgeState = await readState(statePath);

const url = `${COS_API_URL}/api/companies/${COS_COMPANY_ID}/agents/${COS_AGENT_ID}/stream`
  + (state.lastMessageId ? `?since=${state.lastMessageId}` : "");

const sse = new EventSource(url, { headers: { Authorization: `Bearer ${COS_AGENT_KEY}` } });

sse.addEventListener("message", (evt) => {
  const data = JSON.parse(evt.data);
  if (data.type !== "message.created") return;

  // Self-loop filter
  if (data.message.senderAgentId === COS_AGENT_ID) {
    state.lastMessageId = data.message.id;
    writeState(statePath, state);
    return;
  }

  // Dispatch to Claude
  mcp.notification({
    method: "notifications/claude/channel",
    params: { content: data.message.body, meta: {
      sender: data.message.senderAgentId ?? data.message.senderUserId ?? "unknown",
      thread_ts: data.message.replyToId ?? "",
      channel: data.roomId,
      room_id: data.roomId,
      message_id: data.message.id,
      is_bot: data.message.senderAgentId ? "true" : "false",
    }},
  });

  state.lastMessageId = data.message.id;
  writeState(statePath, state);
});

sse.addEventListener("error", () => {
  // EventSource auto-reconnects with Last-Event-ID header if we set id on events
  // Our server honors ?since= based on lastMessageId we track separately
  // Reconnect logic: exponential backoff, reset URL with new since=
});
```

---

## 9. DB 스키마

### 9.1 Migration 0064: `leader_processes`

```sql
CREATE TABLE "leader_processes" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id"       uuid NOT NULL,
  "agent_id"         uuid NOT NULL,
  "session_id"       uuid,                -- FK agent_sessions, nullable if stopped
  "status"           text NOT NULL,       -- stopped|starting|running|stopping|crashed
  "pm2_name"         text,                -- name used in PM2 ecosystem (e.g. "cos-cyrus-43ff")
  "pm2_pm_id"        integer,             -- PM2 internal id from pm2.describe
  "pid"              integer,
  "agent_key_id"     uuid,
  "started_at"       timestamp with time zone,
  "stopped_at"       timestamp with time zone,
  "last_heartbeat_at" timestamp with time zone,
  "exit_code"        integer,
  "exit_reason"      text,
  "error_message"    text,
  "created_at"       timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"       timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "leader_processes_company_fk"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id"),
  CONSTRAINT "leader_processes_agent_fk"
    FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE,
  CONSTRAINT "leader_processes_agent_unique" UNIQUE ("agent_id"),
  CONSTRAINT "leader_processes_agent_key_fk"
    FOREIGN KEY ("agent_key_id") REFERENCES "agent_api_keys"("id") ON DELETE SET NULL,
  CONSTRAINT "leader_processes_status_check"
    CHECK (status IN ('stopped','starting','running','stopping','crashed'))
);
CREATE INDEX "leader_processes_company_idx" ON "leader_processes"("company_id");
CREATE INDEX "leader_processes_status_idx" ON "leader_processes"("status");
```

### 9.2 Migration 0065: `agent_sessions`

```sql
CREATE TABLE "agent_sessions" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id"      uuid NOT NULL,
  "agent_id"        uuid NOT NULL,
  "workspace_path"  text NOT NULL,     -- ~/.cos-v2/leaders/<slug>-<sessionshort>/
  "claude_project_dir" text,           -- optional: <workspace_path>, exposed to Claude as CLAUDE_PROJECT_DIR
  "status"          text NOT NULL,     -- active|archived
  "created_at"      timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"      timestamp with time zone NOT NULL DEFAULT now(),
  "archived_at"     timestamp with time zone,
  "archive_reason"  text,
  CONSTRAINT "agent_sessions_company_fk"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id"),
  CONSTRAINT "agent_sessions_agent_fk"
    FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE,
  CONSTRAINT "agent_sessions_status_check"
    CHECK (status IN ('active','archived'))
);
CREATE INDEX "agent_sessions_agent_status_idx" ON "agent_sessions"("agent_id","status");
CREATE INDEX "agent_sessions_company_idx" ON "agent_sessions"("company_id");

-- 한 agent에 active session 최대 1개 (partial unique index)
CREATE UNIQUE INDEX "agent_sessions_one_active_per_agent"
  ON "agent_sessions"("agent_id") WHERE status = 'active';
```

### 9.3 설계 노트

- `leader_processes.session_id` FK → active session. Restart는 기존 session 재사용.
- `agent_sessions.workspace_path` — workspace는 session에 속함. Archive 시 디렉토리 유지 (Claude history 보존).
- `partial unique index` — DB 레벨에서 "에이전트당 active session 1개" 보장.
- `claude_project_dir` 값은 Claude CLI가 `~/.claude/projects/<hash(cwd)>/` 생성할 때 사용하는 cwd. 같은 workspace_path 로 재시작하면 자동 복원.

---

## 10. 도메인 서비스

### 10.1 `agentSessionService`

```ts
interface AgentSessionService {
  /** Get active session or create a new one. Idempotent. */
  ensureActive(params: { companyId: string; agentId: string }): Promise<AgentSessionRow>;
  /** Archive the active session (on agent role change, manual reset, etc). */
  archive(params: { sessionId: string; reason: string }): Promise<AgentSessionRow>;
  /** Get the active session, if any. */
  getActive(params: { agentId: string }): Promise<AgentSessionRow | null>;
  /** List all sessions for an agent (for history UI). */
  listByAgent(params: { agentId: string }): Promise<AgentSessionRow[]>;
}
```

### 10.2 `leaderProcessService`

```ts
interface LeaderProcessService {
  start(params: { companyId: string; agentId: string }): Promise<LeaderProcessRow>;
  stop(params: { agentId: string; timeoutMs?: number }): Promise<LeaderProcessRow>;
  restart(params: { companyId: string; agentId: string }): Promise<LeaderProcessRow>;
  status(params: { agentId: string }): Promise<LeaderProcessStatus>;
  list(params: { companyId: string }): Promise<LeaderProcessRow[]>;
  /** Startup hook: sync DB ↔ PM2 reality. */
  reconcile(): Promise<{ reconciled: number; crashed: number; revived: number }>;
}
```

**의존성 (DI)**:

```ts
interface Deps {
  db: Db;
  teamService: TeamService;
  roomService: RoomService;
  agentKeyService: AgentKeyService;
  agentSessionService: AgentSessionService;
  workspaceProvisioner: WorkspaceProvisioner;
  processBackend: ProcessBackend;
  clock: { now(): Date };
  logger: Logger;
  /** Per-agent mutex for start/stop races */
  mutexFactory: (key: string) => AsyncMutex;
}
```

### 10.3 상태 머신

```
              ┌──────────┐
              │ stopped  │ ◀─────────────────┐
              └────┬─────┘                   │
           start() │                         │
                   ▼                         │
              ┌──────────┐  fail             │
              │ starting │──────────▶ stopped│
              └────┬─────┘    error_message  │
    spawn+alive    │                         │
                   ▼                         │
              ┌──────────┐                   │
              │ running  │ ◀──restart──┐    │
              └────┬─────┘             │    │
          stop()   │                   │    │
                   ▼                   │    │
              ┌──────────┐             │    │
              │ stopping │─────────────┘    │
              └────┬─────┘                   │
        exit ok    │                         │
                   ▼                         │
              ┌──────────┐                   │
              │ stopped  │───────────────────┘
              └──────────┘

              ┌──────────┐
              │ running  │
              └────┬─────┘
    PM2 reports    │ exit (unplanned)
                   ▼
              ┌──────────┐
              │ crashed  │── user clicks Start ──▶ stopped → starting
              └──────────┘
```

**Allowed transitions** (`start()` 가 allowed인 상태):
- `stopped`, `crashed` → OK
- `running`, `starting`, `stopping` → 409

**`stop()` 가 allowed인 상태**:
- `running`, `starting` → OK (graceful)
- `stopped`, `crashed` → 200 no-op (idempotent)
- `stopping` → 200 no-op (이미 진행 중)

### 10.4 `start()` 순서 (concurrency-safe)

```ts
async start({ companyId, agentId }) {
  // 1. Per-agent mutex — 동일 agent의 concurrent start/stop 직렬화
  return mutexFactory(`leader:${agentId}`).runExclusive(async () => {

    // 2. DB transaction — row state 전이만. IO 없음.
    const row = await db.transaction(async (tx) => {
      const existing = await tx.select().from(leaderProcesses)
        .where(eq(leaderProcesses.agentId, agentId))
        .for("update")
        .limit(1);
      if (existing[0] && !["stopped","crashed"].includes(existing[0].status)) {
        throw errorWithStatus(`Cannot start: status=${existing[0].status}`, 409);
      }
      return upsert(tx, {
        agentId, companyId, status: "starting",
        stoppedAt: null, exitCode: null, exitReason: null, errorMessage: null,
      });
    });

    // 3. Side effects 밖에서 수행
    try {
      const session = await agentSessionService.ensureActive({ companyId, agentId });
      const workspace = await workspaceProvisioner.provision({
        companyId, agentId, sessionId: session.id,
      });
      const handle = await processBackend.spawn({
        name: `cos-${slug(agentId)}`,
        workspace,
        script: resolveClaudePath(),
        args: [
          "--dangerously-skip-permissions",
          "--dangerously-load-development-channels", "server:channel-bridge",
        ],
        env: workspace.env,
      });
      await markRunning({
        agentId, sessionId: session.id,
        pm2Name: handle.name, pm2PmId: handle.pmId, pid: handle.pid,
      });
      return reload(agentId);
    } catch (err) {
      await markStopped(agentId, `start failed: ${err.message}`);
      throw err;
    }
  });
}
```

### 10.5 `reconcile()` (PM2 양방향)

```ts
async reconcile() {
  const dbRows = await db.select().from(leaderProcesses);
  const pm2List = await processBackend.list();  // pm2.list()

  const dbByName = new Map(dbRows.map((r) => [r.pm2Name, r]));
  const pm2ByName = new Map(pm2List.map((p) => [p.name, p]));

  let reconciled = 0, crashed = 0, revived = 0;

  // DB says running/starting/stopping → check PM2
  for (const row of dbRows) {
    if (!["running","starting","stopping"].includes(row.status)) continue;
    const pm2Proc = row.pm2Name ? pm2ByName.get(row.pm2Name) : null;
    if (!pm2Proc || pm2Proc.status !== "online") {
      await markCrashed(row.agentId, pm2Proc?.status ?? "missing from PM2");
      crashed++;
    } else {
      // Sync pid / status if drifted
      if (row.status !== "running") {
        await markRunning({ agentId: row.agentId, /* ... */ });
        reconciled++;
      }
    }
  }

  // PM2 has a cos-* process but DB doesn't → kill (orphan)
  for (const p of pm2List) {
    if (!p.name?.startsWith("cos-")) continue;
    if (!dbByName.has(p.name)) {
      await processBackend.stop(p.name);
      logger.warn({ name: p.name }, "reconcile: killed orphan PM2 process");
    }
  }

  return { reconciled, crashed, revived };
}
```

**Startup hook**: `app.ts` bootstrap 에서 `await leaderProcessService.reconcile()` 호출. 그 후 `app.listen()`.

---

## 11. `ProcessBackend` 인터페이스

```ts
// server/src/services/process-backend.ts
export interface ProcessBackend {
  spawn(spec: ProcessSpec): Promise<ProcessHandle>;
  stop(name: string, timeoutMs?: number): Promise<{ exitCode: number | null }>;
  list(): Promise<ProcessInfo[]>;
  describe(name: string): Promise<ProcessInfo | null>;
  isAlive(name: string): Promise<boolean>;
  /** SSE-friendly log tail. */
  tailLog(name: string, kind: "out" | "err", lines: number): Promise<string[]>;
}

export interface ProcessSpec {
  name: string;                 // unique PM2 process name, e.g., "cos-cyrus-43ff837d"
  script: string;               // absolute path to claude binary
  args: string[];
  cwd: string;                  // workspace dir
  env: Record<string, string>;
  logFile?: string;             // optional log path (PM2 default if omitted)
}

export interface ProcessHandle {
  name: string;
  pmId: number;
  pid: number;
}

export interface ProcessInfo {
  name: string;
  pmId: number;
  pid: number | null;
  status: "online" | "stopped" | "errored" | "launching" | "stopping" | "unknown";
  uptime: number;
  restartCount: number;
  memory: number;
  cpu: number;
}
```

### 11.1 `Pm2ProcessBackend` (production 기본)

```ts
import pm2 from "pm2";

export function createPm2Backend(): ProcessBackend {
  // Lazy connect — first use, retain connection
  let connected = false;
  const ensureConnected = async () => {
    if (connected) return;
    await new Promise<void>((ok, fail) =>
      pm2.connect((err) => err ? fail(err) : (connected = true, ok())));
  };

  return {
    async spawn(spec) {
      await ensureConnected();
      return new Promise((resolve, reject) => {
        pm2.start({
          name: spec.name,
          script: spec.script,
          args: spec.args,
          cwd: spec.cwd,
          env: spec.env,
          out_file: spec.logFile ?? path.join(spec.cwd, "logs/stdout.log"),
          error_file: path.join(spec.cwd, "logs/stderr.log"),
          merge_logs: true,
          autorestart: true,
          max_restarts: 10,
          restart_delay: 2000,
          exp_backoff_restart_delay: 1000,
          kill_timeout: 10_000,
          time: true,   // prepend timestamps to logs
        }, (err, apps) => {
          if (err) return reject(err);
          const app = apps[0];
          resolve({
            name: app.name,
            pmId: app.pm_id,
            pid: app.pid,
          });
        });
      });
    },
    async stop(name, timeoutMs = 10_000) { /* pm2.stop + pm2.describe for exitCode */ },
    async list() { /* pm2.list() + map to ProcessInfo[] */ },
    async describe(name) { /* pm2.describe(name)[0] or null */ },
    async isAlive(name) { /* describe().status === "online" */ },
    async tailLog(name, kind, lines) { /* read last N lines of log file */ },
  };
}
```

**PM2 daemon lifecycle**: `pm2.connect()` 가 daemon 부팅. `pm2 kill` 로만 종료. COS v2 서버 재시작해도 daemon + managed processes 계속 살아 있음.

**로그 로테이션**: `pm2-logrotate` 모듈을 서버 최초 부팅 시 `pm2 install pm2-logrotate` 로 설치. 이것도 프로그래매틱:

```ts
async function ensurePm2LogRotate() {
  const installed = await describeModule("pm2-logrotate");
  if (installed) return;
  await new Promise<void>((ok, fail) =>
    pm2.install("pm2-logrotate", (err) => err ? fail(err) : ok()));
  // Configure
  execFile("pm2", ["set", "pm2-logrotate:max_size", "10M"]);
  execFile("pm2", ["set", "pm2-logrotate:retain", "5"]);
  execFile("pm2", ["set", "pm2-logrotate:compress", "true"]);
}
```

### 11.2 `FakeProcessBackend` (테스트 전용)

```ts
export function createFakeProcessBackend(): ProcessBackend {
  const map = new Map<string, FakeProcess>();
  return {
    async spawn(spec) {
      const fake = { name: spec.name, pmId: Math.random()*1e9|0, pid: Math.random()*1e9|0, status: "online", ... };
      map.set(spec.name, fake);
      return { name: fake.name, pmId: fake.pmId, pid: fake.pid };
    },
    async stop(name) { /* mark stopped */ },
    async list() { return [...map.values()].map(toProcessInfo); },
    // ... etc
  };
}
```

**DI 분기**: `app.ts` 에서 `process.env.NODE_ENV === "test"` 이면 `createFakeProcessBackend()`, else `createPm2Backend()`.

---

## 12. `WorkspaceProvisioner`

```ts
export interface WorkspaceProvisioner {
  provision(params: {
    companyId: string; agentId: string; sessionId: string;
  }): Promise<LeaderWorkspace>;
  /** Remove workspace dir. Called on agent delete (after stop). */
  destroy(params: { sessionId: string }): Promise<void>;
}

export interface LeaderWorkspace {
  root: string;         // ~/.cos-v2/leaders/<slug>-<sessionshort>/
  companyId: string;
  agentId: string;
  sessionId: string;
  agentKey: string;     // plaintext, only in memory
  env: Record<string, string>;
}
```

### 12.1 provision 로직

```ts
async provision({ companyId, agentId, sessionId }) {
  const agent = await agentService.getByIdInCompany(agentId, companyId);
  if (!agent) throw new Error("Agent not in company");

  const session = await sessionService.getById(sessionId);
  if (session.status !== "active") throw new Error("Session not active");

  // Workspace path from session — REUSE session's workspace_path
  // to preserve Claude's ~/.claude/projects/<hash(cwd)>/ history.
  const root = session.workspacePath;
  await fs.mkdir(path.join(root, "logs"), { recursive: true });
  await fs.chmod(root, 0o700);

  // Agent key — reuse active, else issue new
  const { plaintext, keyRow } = await agentKeyService.ensureActive({
    agentId, label: "leader-cli",
  });

  // .mcp.json — bridge command using tsx
  const bridgeEntry = path.resolve(REPO_ROOT, "packages/channel-bridge-cos/src/index.ts");
  const tsxBin = path.resolve(REPO_ROOT, "node_modules/.bin/tsx");
  const mcpJson = {
    mcpServers: {
      "channel-bridge": {
        command: tsxBin,
        args: [bridgeEntry],
        env: {
          COS_API_URL: "http://127.0.0.1:3101",
          COS_COMPANY_ID: companyId,
          COS_AGENT_ID: agentId,
          COS_AGENT_KEY: plaintext,
          COS_WORKSPACE: root,
          COS_SESSION_ID: sessionId,
        },
      },
    },
  };
  await fs.writeFile(path.join(root, ".mcp.json"), JSON.stringify(mcpJson, null, 2), { mode: 0o600 });

  return {
    root, companyId, agentId, sessionId, agentKey: plaintext,
    env: {
      // env for the claude CLI itself (separate from mcpServers.env)
      CLAUDE_PROJECT_DIR: root,
      // COS_* also exposed to CLI so it could read them if needed
      COS_API_URL: "http://127.0.0.1:3101",
      COS_COMPANY_ID: companyId,
      COS_AGENT_ID: agentId,
      COS_SESSION_ID: sessionId,
    },
  };
}
```

**핵심 결정**:
- `workspace_path`는 **session에 속한다** (DB 컬럼). Restart 시 동일 path 재사용 → Claude `~/.claude/projects/<hash(root)>/` 자동 복원.
- `.mcp.json`은 매 start마다 rewrite — agent key / env / tsx path 등이 repo 이동·키 rotate 등으로 바뀔 수 있음.
- `CLAUDE.md`/`instructions.md` **파일 생성 안 함**. Bridge의 MCP `instructions:` 필드만 사용.

### 12.2 Bridge instructions 필드

Bridge가 start 할 때 서버에 `GET /agents/:aid/team-instructions` 로 fetch → MCP server 생성 시 `instructions:` 에 embed. 파일 없음, 항상 fresh.

---

## 13. `channel-bridge-cos` — `packages/channel-bridge-cos/`

### 13.1 Package 구조

```
packages/channel-bridge-cos/
├── package.json           — { "name": "@paperclipai/channel-bridge-cos", "private": true, "type": "module" }
├── tsconfig.json          — extends ../../tsconfig.base.json
├── src/
│   ├── index.ts           — entry point
│   ├── state.ts           — state.json read/write
│   ├── sse-client.ts      — EventSource wrapper with reconnect + cursor
│   ├── mcp-server.ts      — MCP server setup + tool handlers
│   └── env.ts             — env var validation
└── src/index.test.ts
```

### 13.2 Entry point (pseudocode)

```ts
// packages/channel-bridge-cos/src/index.ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { env } from "./env.js";
import { readState, writeState } from "./state.js";
import { createSseClient } from "./sse-client.js";
import { fetchInstructions } from "./instructions.js";

// 1. Fetch dynamic instructions from server
const instructions = await fetchInstructions(env);

// 2. Create MCP server
const mcp = new Server(
  { name: "channel-bridge-cos", version: "0.1.0" },
  {
    instructions,
    capabilities: { experimental: { "claude/channel": {} }, tools: {} },
  },
);

// 3. Tools
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [REPLY_TOOL, EDIT_TOOL] }));
mcp.setRequestHandler(CallToolRequestSchema, handleTool);

async function handleTool(req) {
  if (req.params.name === "reply") return handleReply(req.params.arguments);
  if (req.params.name === "edit_message") return handleEdit(req.params.arguments);
  return { content: [{ type: "text", text: `unknown tool: ${req.params.name}` }], isError: true };
}

async function handleReply({ message, thread_ts, target_channel }) {
  const targetRoom = target_channel ?? lastReceivedRoomId;
  const res = await fetch(
    `${env.COS_API_URL}/api/companies/${env.COS_COMPANY_ID}/rooms/${targetRoom}/messages`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${env.COS_AGENT_KEY}` },
      body: JSON.stringify({ type: "text", body: message, replyToId: thread_ts || null }),
    },
  );
  const data = await res.json();
  return res.ok
    ? { content: [{ type: "text", text: `sent (id: ${data.id})` }] }
    : { content: [{ type: "text", text: `error: ${data.error}` }], isError: true };
}

// 4. SSE client — auto reconnect with cursor
const state = await readState(env.COS_WORKSPACE);
let lastReceivedRoomId: string | null = null;

const sse = createSseClient({
  url: () => `${env.COS_API_URL}/api/companies/${env.COS_COMPANY_ID}/agents/${env.COS_AGENT_ID}/stream`
    + (state.lastMessageId ? `?since=${state.lastMessageId}` : ""),
  headers: () => ({ Authorization: `Bearer ${env.COS_AGENT_KEY}` }),
  onMessage: async (evt) => {
    if (evt.type !== "message.created") return;
    // Self-loop filter
    if (evt.message.senderAgentId === env.COS_AGENT_ID) {
      state.lastMessageId = evt.message.id;
      await writeState(env.COS_WORKSPACE, state);
      return;
    }
    lastReceivedRoomId = evt.roomId;
    await mcp.notification({
      method: "notifications/claude/channel",
      params: {
        content: evt.message.body,
        meta: {
          sender: evt.message.senderAgentId ?? evt.message.senderUserId ?? "unknown",
          thread_ts: evt.message.replyToId ?? "",
          channel: evt.roomId,
          room_id: evt.roomId,
          message_id: evt.message.id,
          is_bot: evt.message.senderAgentId ? "true" : "false",
        },
      },
    });
    state.lastMessageId = evt.message.id;
    await writeState(env.COS_WORKSPACE, state);
  },
  onReconnect: (attempt) => console.error(`[bridge] reconnect attempt ${attempt}`),
  backoff: { initial: 1000, max: 30_000, multiplier: 2 },
});

// 5. Start MCP stdio
await mcp.connect(new StdioServerTransport());
```

### 13.3 Self-loop guard (중요)

서비스 레이어 추가 guard — bridge가 `reply` tool 호출 시:

```ts
// server/src/services/rooms.ts createMessage
const msg = await insertRow(...);
// Publish with is_bot marker
const isBot = !!msg.senderAgentId;
roomStreamBus.publish(msg.roomId, {
  type: "message.created",
  message: { ...msg, _isBot: isBot },
});
```

Bridge는 이벤트 받을 때 `senderAgentId === self` 체크. 서비스는 메타로 `_isBot` 표시.
**이중 guard** (bridge + 서버) 가 있어야 한 쪽이 깨져도 루프 방지.

---

## 14. UI — Agent Detail "CLI Process" 카드

Agent Detail 페이지 (leader 에이전트에 한해, `leadsTeams === true`):

```
┌──────────────────────────────────────────────────────────┐
│ CLI Process                    ● running  (5m 23s)        │
├──────────────────────────────────────────────────────────┤
│ Session      engine-cyrus-43ff837d (active)               │
│ Workspace    ~/.cos-v2/leaders/cyrus-43ff837d/            │
│ PM2          cos-cyrus-43ff  (pid 45721, restarts 0)      │
│ Rooms        ENG3 engine-standup, ENG3 eng-ops            │
│ Bridge       channel-bridge-cos v0.1.0                    │
│                                                            │
│ [Stop]  [Restart]  [Archive session]  [View artifacts]    │
│                                                            │
│ ▼ Live log  (stdout · last 20 lines)                      │
│ [14:20:01] channel-bridge connected                        │
│ [14:20:02] subscribed: agent/43ff837d                     │
│ [14:20:15] message received: "Hi Cyrus"                   │
│ [14:20:18] reply sent (id: abc-123)                       │
│ ...                                                        │
└──────────────────────────────────────────────────────────┘
```

- **Status dot**: `stopped`=gray, `starting`=blue pulse, `running`=emerald, `stopping`=amber pulse, `crashed`=red
- **Logs**: `/cli/logs/stream` SSE endpoint, 20줄 슬라이딩 윈도우
- **Archive session**: 현재 session archive + 새 session 으로 restart (컨텍스트 리셋 원할 때)
- **View artifacts**: dialog로 `.mcp.json` 내용 syntax-highlighted (key는 masked)

관리자 뷰 `/settings/leader-processes`: 회사 전체 리더 프로세스 테이블.

---

## 15. 실패 모드 & 복구

| # | 실패 | 감지 | 상태 전이 | 처리 |
|---|---|---|---|---|
| F1 | Workspace dir 생성 실패 | `fs.mkdir` throw | `starting → stopped` | error_message 기록 |
| F2 | Agent key 발급 실패 | service error | `starting → stopped` | 동일 |
| F3 | PM2 daemon 죽음 | `pm2.connect` err | `starting → stopped` | "PM2 daemon not running" |
| F4 | Claude 바이너리 없음 | PM2 exit code | `starting → crashed` | stdout/stderr 200줄 error_message |
| F5 | Spawn 후 즉시 exit | PM2 status="errored" within 5s | `starting → crashed` | 동일 |
| F6 | 정상 중 crash | PM2 'exit' 이벤트 | `running → crashed` | UI "Start again" |
| F7 | PM2 autorestart loop | PM2 restart_count > 10 | `running → crashed` | max_restarts 도달 |
| F8 | Stop SIGTERM 무시 | PM2 kill_timeout | `stopping → stopped` | SIGKILL fallback, exit_reason="forced" |
| F9 | SSE 끊김 (bridge) | EventSource onerror | 영향 없음 (CLI 생존) | exponential backoff reconnect with cursor |
| F10 | 룸 멤버십 변경 | `room_participants` insert/delete hook | agentStreamBus.publish(agentId, {type:"membership.changed"}) | Bridge는 SSE 재구독 (subscription set 자동 갱신 on server side) |
| F11 | 서버 재시작 | `reconcile()` at startup | DB ↔ PM2 diff | DB running + PM2 missing → crashed<br>PM2 present + DB missing → pm2.stop (orphan) |
| F12 | Agent key revoke 중 running | bridge HTTP 401 | 영향 없음 | bridge exit, PM2 restart loop → user 조치 필요 |
| F13 | Agent 삭제 while running | `agents.delete` service hook | `running → stopping → stopped` → session archive → workspace 삭제 | cascade cleanup |
| F14 | Disk full (log) | PM2 log write 실패 | 영향 없음 on CLI | PM2 자동 회전 시 해결. 감지 못하면 수동 |
| F15 | 동일 agent start race | per-agent mutex | 첫 번째만 진행 | 나머지 409 |
| F16 | self-message loop (bridge 버그) | bridge guard + server meta | 이벤트 skip | 로그 경고 |

각 실패는 **integration test scenario**. 섹션 18 참조.

---

## 16. 관측 가능성

1. **구조화된 로그**: 모든 상태 전이는 `logger.info({ agentId, from, to, reason, pm2_name })`
2. **DB 감사**: `leader_processes.updated_at` 자동 갱신. Activity Log 통합:
   - `leader.start.requested` / `leader.started` / `leader.crashed` / `leader.stopped`
3. **Health check**: `GET /api/health` 에 `leaderProcesses: { running, crashed, totalRegistered }`
4. **PM2 metrics**: `describe(name).monit` → CPU, memory, uptime. UI 카드에 표시
5. **SSE 연결 수**: `streamBus.stats()` → `/api/diagnostics/stream-bus` 엔드포인트 (admin)

---

## 17. 멀티 리더 룸 semantics

**MVP 정책**: 한 룸에 여러 리더가 있으면 **모두** 응답한다.

이유:
- Claude channel 매커니즘이 agent 선택 로직을 제공하지 않음
- turn-taking은 메시지 내용 기반 (`@Cyrus`, `@Luna`) 이어야 자연스러움
- 이 로직은 Phase 5 (`@-mention` 라우팅) 으로 미룸

**MVP 완화책**:
- Bridge의 `is_bot` 메타를 Claude가 인지할 수 있도록 `instructions:` 에 가이드 추가: "다른 에이전트가 이미 답한 경우 중복 응답 피할 것"
- 이건 Claude의 판단에 맡김 (strict하지 않음)

**Phase 5 계획**:
- 메시지 body에서 `@<agentName>` 파싱
- 해당 agent의 stream에만 publish
- 멘션 없으면 룸 owner / primary leader 에게만

---

## 18. Invariants + Test Scenarios

### 18.1 `leaderProcessService` invariants

| Invariant | Test scenario |
|---|---|
| I1. start(X) after stop(X) always succeeds if workspace valid | `stopped → starting → running`, verify via `status()` |
| I2. reconcile() is idempotent | run twice in a row, second call returns `{ reconciled: 0, ... }` |
| I3. Concurrent start(X) calls — one wins, others get 409 | fire 5 parallel start → 1 running, 4 errors |
| I4. crashed status is recoverable via start | manual set status=crashed, call start → running |
| I5. Agent deletion cascades to stopping + workspace removal | delete agent → leader_process row removed, workspace dir gone |
| I6. stop(X) is idempotent on already-stopped | second stop returns 200 no-op |
| I7. restart after crash restores to running | crashed → restart → running |
| I8. start blocks on in-progress stop (mutex) | stop()를 delay mock → parallel start → start waits |

### 18.2 `agentSessionService` invariants

| Invariant | Test scenario |
|---|---|
| S1. Only one active session per agent | partial unique index + service guard |
| S2. ensureActive is idempotent | call twice → same row |
| S3. archive → ensureActive creates new | archive, call ensureActive → new row id |
| S4. Workspace path is stable for an active session | restart leader → same workspace_path |

### 18.3 Message delivery invariants

| Invariant | Test scenario |
|---|---|
| M1. Zero-duplicate delivery on SSE reconnect | set cursor → reconnect → only new events |
| M2. Zero-loss during reconnect window | disconnect, POST message, reconnect with cursor → message received |
| M3. Self-sent messages not re-dispatched | bridge posts via reply tool → self filter skips |
| M4. Membership change triggers subscription set update | add agent to new room → stream delivers messages from that room without restart |
| M5. Cursor persisted across bridge restart | kill bridge → restart → resumes from state.json |

### 18.4 E2E integration scenarios

1. **Happy path**: Create room → add Cyrus → start leader → post message → Cyrus replies via channel
2. **Crash recovery**: Start leader → kill -9 PM2 process → PM2 autorestart → continues receiving messages
3. **Server restart**: Start leader → restart COS v2 server → reconcile finds leader alive → continues
4. **Membership change**: Leader running → add new room → leader receives messages from new room without restart
5. **Concurrent start blocking**: `start(X)` fires → second `start(X)` before first completes → 409
6. **Multi-leader room**: Two leaders in same room → both receive → both reply (MVP semantics)
7. **Agent deletion cascade**: Running leader → delete agent → stopping → stopped → session archived → workspace removed

---

## 19. 보안

- **Agent key**: `.mcp.json` 평문 저장. 디렉토리 `0700`, 파일 `0600`. Key 는 기존 `agent_api_keys` 인프라. JWT 업그레이드는 Phase 5 후속.
- **SSE 인증**: Bearer 헤더 (EventSource는 `fetch` 대체 wrapper 사용). Query token fallback 없음 (v2는 안 감).
- **Cross-tenant**: SSE 엔드포인트에서 `req.actor.agentId === aid && companyMatch` 강제. Bridge가 혹시 다른 agent의 key로 요청해도 서버에서 거부.
- **`--dangerously-*`**: local trust mode 에서만. 프로덕션 배포는 Phase 5 sandboxed wrapper.
- **PM2 daemon**: OS 사용자 권한으로 실행. 서버와 동일 uid/gid.

---

## 20. 의존성 추가

- `pm2` — workspace root `package.json` dependencies. 개발/프로덕션 공통.
- `async-mutex` — per-agent 직렬화.
- `eventsource` (bridge) — Node에 `EventSource` 없음. `packages/channel-bridge-cos/package.json` 에 추가.
- 기존 `@modelcontextprotocol/sdk` 재사용 (플러그인 SDK에 이미 포함).

---

## 21. 빌드 순서 (sub-units)

각 유닛 = 코드 + 유닛 테스트 + 브라우저 E2E (UI 포함 시) + 코드 리뷰 + 커밋 + progress.md 업데이트.

| # | 유닛 | 범위 |
|---|---|---|
| **4a** | 설계 v2 (이 문서) | 리뷰 OK |
| **4b** | `lib/stream-bus.ts` primitive 추출 + `plugin-stream-bus` 어댑터 리팩터 | 기존 플러그인 regression 0, unit test |
| **4c** | `room-stream-bus` + `agent-stream-bus` + `createMessage` publish 훅 | unit test, publish count |
| **4d** | SSE 엔드포인트 `GET /agents/:aid/stream` + cursor `?since` | curl -N 검증, replay + live + race window |
| **4e** | Migration 0064 (`leader_processes`) + 0065 (`agent_sessions`) + schema + validators | drizzle migrate OK |
| **4f** | `agentSessionService` + `ensureActive` 로직 | unit test on invariants S1-S4 |
| **4g** | `ProcessBackend` 인터페이스 + `FakeProcessBackend` + `leaderProcessService` skeleton | invariants I1-I8 (mocked) |
| **4h** | `Pm2ProcessBackend` 구현 + `pm2` dep 추가 + logrotate 설치 훅 | 더미 커맨드 spawn/stop 테스트 |
| **4i** | `WorkspaceProvisioner` 구현 | file IO 검증 |
| **4j** | `packages/channel-bridge-cos/` 패키지 초기화 + 엔트리 + state + SSE client + tests | 독립 실행 smoke test |
| **4k** | `POST /cli/start|stop|restart` + `GET /cli/status` 라우트 | API QA |
| **4l** | UI "CLI Process" 카드 + live log SSE endpoint + `/cli/logs` stream | 브라우저 검증 — 실제 Cyrus 시작/정지 |
| **4m** | End-to-end: 룸에 사람이 메시지 → Cyrus CLI 가 답장 → 브라우저에서 확인 | 실 사용 검증 |
| **4n** | `reconcile()` + startup hook + agent delete cascade | 서버 재시작 테스트, agent delete cleanup |
| **4o** | 멀티 리더 + 멤버십 변경 자동 반영 + 회복 시나리오 | 3명 동시 실행, 룸 이동 테스트 |

15개 sub-unit. 각각 독립 커밋. 4a~4k 는 infra/백엔드, 4l~4o 는 사용자 검증.

---

## 22. 오픈 이슈 / 사전 검증 필요

| # | 이슈 | 결정 또는 검증 방법 |
|---|---|---|
| O1 | `pm2` npm package 가 workspace에 잘 들어가는지 | 4h에서 `pnpm add pm2 -w` 실행, `pm2.connect` smoke test |
| O2 | `--dangerously-load-development-channels server:channel-bridge` 의 `server:` prefix 의미 | v1 패턴 그대로 사용. 4j 스모크 테스트에서 실제 notification 수신 확인 |
| O3 | Claude CLI가 MCP notification `claude/channel` 에 실제로 반응하는지 | 4j에서 수동 테스트: dummy message → Claude 로그에 반응 여부 |
| O4 | `tsx` CLI path 해결 (`node_modules/.bin/tsx`) 이 worktree config 에서 안정한지 | provision 코드가 `require.resolve("tsx/cli")` 사용 고려 |
| O5 | Claude CLI 가 MCP server의 `instructions:` 필드를 실제로 시스템 프롬프트에 포함하는지 | 4j 스모크 테스트에서 확인 |
| O6 | `~/.claude/projects/<hash>/` 복원이 cwd 동일성에 의존하는지 | Claude 문서 확인. 4l에서 session restart 후 컨텍스트 지속 검증 |

각 이슈는 해당 유닛 진입 전에 검증. 실패하면 그 유닛이 블로커 → 설계 롤백 또는 대안.

---

## 23. 승인 포인트

이 v2 문서 리뷰 받고 OK 하면 **4b (stream-bus primitive 추출)** 부터 구현 시작.

v1 대비 주요 이득:
- PM2 단일화 → 로그 회전·재시작·리소스 한계 다 해결
- SSE cursor → 메시지 정확히 한 번 전달
- Agent-scoped stream → 룸 변경 자동 반영, 수동 restart 제거
- Session 분리 → Claude 컨텍스트 보존
- channel-bridge-cos 패키지 → 빌드/배포 명확
- 실패 모드 16개 표 + invariant 20개 + E2E 7 시나리오 — 테스트 가능성 명시

v2가 아직 최고가 아니라면, 추가 비판 받고 v3 작성.
