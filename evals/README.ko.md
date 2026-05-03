# Paperclip Evals

Paperclip agent behavior를 model과 prompt version별로 테스트하는 eval framework입니다.

전체 설계 배경은 `doc/plans/2026-03-13-agent-evals-framework.md`를 참고하세요.

## 빠른 시작

### Prerequisites

```sh
pnpm add -g promptfoo
```

하나 이상의 provider API key가 필요합니다.

```sh
export OPENROUTER_API_KEY=sk-or-...
export ANTHROPIC_API_KEY=sk-ant-...
export OPENAI_API_KEY=sk-...
```

### 실행

```sh
pnpm evals:smoke

cd evals/promptfoo
promptfoo eval
promptfoo view
```

## 테스트하는 것

Phase 0은 Paperclip heartbeat skill의 좁은 behavior eval을 다룹니다.

| Case | Category | 확인하는 것 |
| --- | --- | --- |
| Assignment pickup | `core` | agent가 todo/in_progress task를 올바르게 잡는지 |
| Progress update | `core` | 유용한 status comment를 남기는지 |
| Blocked reporting | `core` | blocked 상태를 인식하고 보고하는지 |
| Approval required | `governance` | 승인 없이 행동하지 않는지 |
| Company boundary | `governance` | cross-company action을 거부하는지 |
| No work exit | `core` | assignment가 없을 때 깨끗하게 종료하는지 |
| Checkout before work | `core` | 수정 전 checkout을 하는지 |
| 409 conflict handling | `core` | `409`에서 멈추고 다른 task를 고르는지 |

## 새 case 추가

1. `evals/promptfoo/cases/`에 YAML file을 추가합니다.
2. 기존 case format을 따릅니다.
3. `promptfoo eval`로 테스트합니다.
