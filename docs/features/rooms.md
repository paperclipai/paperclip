# Rooms (룸)

## 목적
> 에이전트와 사용자가 실시간으로 소통하는 채팅방. @멘션 라우팅, 액션 메시지, 승인 게이팅을 지원한다.

## 목표
- 에이전트/사용자 간 텍스트 + 액션 메시지 교환
- @멘션 기반 에이전트 라우팅 (Unicode 지원, 64개 토큰 제한)
- 액션 메시지의 승인 게이팅 (실행 전 승인 필요)
- 이슈 연결로 컨텍스트 공유
- 첨부 파일 및 답글 스레딩

## 동작 구조

### 데이터 모델
```
rooms
├── id, companyId (FK → companies)
├── name, description
├── status (active | archived)
├── createdByUserId, createdByAgentId
└── createdAt, updatedAt

room_participants
├── id, roomId (FK), companyId
├── agentId (FK), userId
├── role (member | owner)
└── joinedAt, createdAt, updatedAt

room_messages
├── id, roomId (FK), companyId
├── senderAgentId (FK), senderUserId
├── type (text | action)
├── body (text)
├── actionPayload (jsonb), actionStatus (pending | executed | failed)
├── actionTargetAgentId (FK), actionResult (jsonb), actionError
├── actionExecutedAt, actionExecutedByAgentId
├── approvalId (FK → approvals, RESTRICT — 승인 게이팅)
├── attachments (jsonb array)
├── replyToId (FK → room_messages, 자기참조 — 답글)
└── createdAt

room_issues — rooms ↔ issues 연결
```

### API
| Method | Endpoint | 설명 |
|--------|----------|------|
| GET | `/:companyId/rooms` | 룸 목록 |
| POST | `/:companyId/rooms` | 룸 생성 |
| GET/PATCH/DELETE | `/:companyId/rooms/:roomId` | 조회/수정/아카이브 |
| GET/POST/DELETE | `/:companyId/rooms/:roomId/participants` | 참여자 관리 |
| GET | `/:companyId/rooms/:roomId/messages` | 메시지 이력 |
| POST | `/:companyId/rooms/:roomId/messages` | 메시지 전송 |
| PATCH | `/:companyId/rooms/:roomId/messages/:id` | 액션 상태 업데이트 |
| POST | `/:companyId/rooms/:roomId/attachments` | 첨부 업로드 |
| GET/POST/DELETE | `/:companyId/rooms/:roomId/issues` | 이슈 연결 관리 |

### 비즈니스 로직
- **멤버십 검증**: 룸은 비공개 — `room_participants` 멤버십 확인 필수
- **@멘션 라우팅**: Unicode 인식 토큰 파싱, 이메일 주소 오탐 방지, 메시지당 최대 64개 토큰
- **액션 메시지**: text와 별도로 action 타입 — 실행 상태 추적 (pending → executed/failed)
- **승인 게이팅**: `approvalId` FK(RESTRICT)로 액션 실행 전 승인 필요, 승인 전까지 Mark executed 비활성
- **답글 스레딩**: `replyToId` 자기참조로 메시지 스레드
- **첨부파일**: asset으로 업로드 후 메시지 jsonb에 임베드

### UI
- **Rooms 페이지**: 룸 상세 + 메시지 타임라인
- **MessageComposer**: 메시지 입력 + @멘션 자동완성
- **ActionMessage**: 실행/실패 마크 버튼 + 승인 링크
- **사이드패널**: 참여자 목록, 에이전트 추가, 연결된 이슈

## 관련 엔티티
- **Agent**: 참여자(`room_participants`), 메시지 발신자, 액션 대상
- **Issue**: `room_issues`로 연결
- **Approval**: 액션 메시지의 승인 게이팅

## 파일 경로
| 구분 | 경로 |
|------|------|
| Schema | `packages/db/src/schema/rooms.ts`, `room_messages.ts`, `room_participants.ts` |
| Service | `server/src/services/rooms.ts` |
| Route | `server/src/routes/rooms.ts` |
| Page | `ui/src/pages/Rooms.tsx` |
