---
title: 아키텍처
summary: 스택 개요, 요청 흐름, 어댑터 모델
---

# 아키텍처

Paperclip은 네 개의 주요 레이어로 구성된 monorepo입니다.

## 스택 개요

```text
┌─────────────────────────────────────┐
│  React UI (Vite)                    │
│  Dashboard, org, tasks              │
├─────────────────────────────────────┤
│  Express.js REST API (Node.js)      │
│  Routes, services, auth, adapters   │
├─────────────────────────────────────┤
│  PostgreSQL (Drizzle ORM)           │
│  Schema, migrations, embedded mode  │
├─────────────────────────────────────┤
│  Adapters                           │
│  Claude Local, Codex Local,         │
│  Process, HTTP                      │
└─────────────────────────────────────┘
```

## 기술 스택

| 레이어 | 기술 |
| --- | --- |
| Frontend | React 19, Vite 6, React Router 7, Radix UI, Tailwind CSS 4, TanStack Query |
| Backend | Node.js 20+, Express.js 5, TypeScript |
| Database | PostgreSQL 17 또는 embedded PGlite, Drizzle ORM |
| Auth | Better Auth, 세션, API key |
| Adapters | Claude Code CLI, Codex CLI, shell process, HTTP webhook |
| Package manager | pnpm 9 workspaces |

## 레포 구조

```text
paperclip/
├── ui/                 # React frontend
├── server/             # Express.js API
├── packages/db/        # Drizzle schema + migrations
├── packages/shared/    # API types, constants, validators
├── packages/adapters/  # adapter implementations
├── skills/             # agent skills
├── cli/                # CLI client
└── doc/                # internal documentation
```

## 하트비트 요청 흐름

하트비트가 발생하면:

1. Scheduler, manual invoke, assignment, mention 같은 이벤트가 하트비트를 트리거합니다.
2. 서버가 설정된 adapter의 `execute()`를 호출합니다.
3. adapter가 Claude Code CLI 같은 에이전트 프로세스를 실행하고 Paperclip env var와 prompt를 전달합니다.
4. 에이전트가 Paperclip REST API를 호출해 배정 확인, checkout, 작업 수행, 상태 업데이트를 합니다.
5. adapter가 stdout, usage/cost data, session state를 캡처합니다.
6. 서버가 run result, cost, session state를 기록합니다.

## 어댑터 모델

어댑터는 Paperclip과 에이전트 런타임 사이의 브리지입니다. 각 어댑터는 보통 세 부분으로 나뉩니다.

- **Server module**: 에이전트를 실행하거나 호출하는 `execute()`와 환경 진단
- **UI module**: 실행 로그 parser, 에이전트 생성 form field
- **CLI module**: `paperclipai run --watch`용 터미널 formatter

기본 어댑터는 `claude_local`, `codex_local`, `process`, `http`입니다. HTTP API를 호출할 수 있는 런타임이라면 custom adapter를 만들 수 있습니다.

## 설계 결정

- **Control plane, not execution plane**: Paperclip은 실행을 직접 소유하지 않고 오케스트레이션합니다.
- **Company-scoped**: 모든 엔티티는 정확히 한 회사에 속합니다.
- **Single-assignee tasks**: atomic checkout으로 중복 작업을 막습니다.
- **Adapter-agnostic**: HTTP API를 호출할 수 있으면 에이전트가 될 수 있습니다.
- **Embedded by default**: 로컬에서는 별도 DB 설정 없이 시작합니다.
