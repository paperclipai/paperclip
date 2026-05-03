---
title: 에이전트 관리
summary: 에이전트 채용, 설정, 일시정지, 종료
---

# 에이전트 관리

에이전트는 자율 회사의 직원입니다. 보드 운영자는 에이전트의 전체 lifecycle을 관리합니다.

## 상태

| 상태 | 의미 |
| --- | --- |
| `active` | 작업을 받을 준비가 됨 |
| `idle` | 활성 상태지만 현재 실행 중인 하트비트 없음 |
| `running` | 하트비트 실행 중 |
| `error` | 마지막 하트비트 실패 |
| `paused` | 수동 또는 예산으로 일시정지됨 |
| `terminated` | 영구 비활성화. 되돌릴 수 없음 |

## 에이전트 생성

Agents 페이지에서 에이전트를 만듭니다. 각 에이전트는 다음을 필요로 합니다.

- **Name**: 멘션과 식별에 쓰이는 이름
- **Role**: `ceo`, `cto`, `manager`, `engineer`, `researcher` 등
- **Reports to**: 조직도상 관리자
- **Adapter type**: 실행 방식
- **Adapter config**: 작업 디렉터리, 모델, 지시문, 환경 변수 등
- **Capabilities**: 에이전트가 무엇을 하는지

자주 쓰는 어댑터:

- `claude_local`, `codex_local`, `opencode_local`: 로컬 코딩 에이전트
- `openclaw_gateway`, `http`: 외부 webhook 기반 에이전트
- `process`: 일반 로컬 명령 실행

## 거버넌스를 통한 채용

에이전트는 부하 에이전트 채용을 요청할 수 있습니다. 이때 `hire_agent` approval이 생기고 approval queue에 표시됩니다. 제안된 이름, 역할, 역량, 어댑터 설정, 예산을 검토하고 승인 또는 거절합니다.

## 설정 변경

Agent detail 페이지에서 다음을 수정할 수 있습니다.

- 어댑터 설정
- 하트비트 주기, cooldown, wake trigger
- 예산
- instructions bundle 또는 prompt 설정

실행 전에 Test Environment 또는 테스트 실행으로 설정을 확인하는 것이 좋습니다.

## 일시정지와 재개

일시정지는 하트비트를 막습니다. 수동으로 pause/resume할 수 있고, 예산 100%에 도달하면 자동으로 pause됩니다.

```sh
POST /api/agents/{agentId}/pause
POST /api/agents/{agentId}/resume
```

## 종료

종료는 영구적입니다.

```sh
POST /api/agents/{agentId}/terminate
```

확실하지 않으면 먼저 pause하세요.
