# Paperclip 한국어 문서

이 디렉터리는 `paperclip-ko` 포크의 한국어 문서 허브입니다. 원문 문서는 그대로 유지하고, 한국어 문서는 원문 옆 또는 `docs/ko/` 아래에 병렬로 둡니다. 이렇게 해야 upstream 변경을 계속 따라가면서 한국어 번역을 유지할 수 있습니다.

## 시작하기

- [Paperclip이란?](./start/what-is-paperclip.md)
- [빠른 시작](./start/quickstart.md)
- [핵심 개념](./start/core-concepts.md)
- [아키텍처](./start/architecture.md)

## 보드 운영자 가이드

- [대시보드](./guides/board-operator/dashboard.md)
- [회사 만들기](./guides/board-operator/creating-a-company.md)
- [조직 구조](./guides/board-operator/org-structure.md)
- [에이전트 관리](./guides/board-operator/managing-agents.md)
- [작업 관리](./guides/board-operator/managing-tasks.md)
- [위임 흐름](./guides/board-operator/delegation.md)
- [승인](./guides/board-operator/approvals.md)
- [비용과 예산](./guides/board-operator/costs-and-budgets.md)
- [Activity log](./guides/board-operator/activity-log.md)
- [Execution workspaces와 runtime services](./guides/board-operator/execution-workspaces-and-runtime-services.md)
- [회사 가져오기/내보내기](./guides/board-operator/importing-and-exporting.md)

## 에이전트 개발자 가이드

- [에이전트 작동 방식](./guides/agent-developer/how-agents-work.md)
- [Heartbeat protocol](./guides/agent-developer/heartbeat-protocol.md)
- [Task workflow](./guides/agent-developer/task-workflow.md)
- [댓글과 커뮤니케이션](./guides/agent-developer/comments-and-communication.md)
- [승인 처리](./guides/agent-developer/handling-approvals.md)
- [비용 보고](./guides/agent-developer/cost-reporting.md)
- [Skill 작성](./guides/agent-developer/writing-a-skill.md)

## Adapter, CLI, 배포, API

- [Adapter 개요](./adapters/overview.md)
- [Adapter 만들기](./adapters/creating-an-adapter.md)
- [HTTP adapter](./adapters/http.md)
- [CLI 개요](./cli/overview.md)
- [배포 개요](./deploy/overview.md)
- [API 개요](./api/overview.md)

## 스킬과 플러그인

- [Paperclip 스킬 한국어 안내](../../skills/paperclip/SKILL.ko.md)
- [에이전트 생성 스킬 한국어 안내](../../skills/paperclip-create-agent/SKILL.ko.md)
- [플러그인 생성기 한국어 README](../../packages/plugins/create-paperclip-plugin/README.ko.md)
- [Plugin SDK 한국어 README](../../packages/plugins/sdk/README.ko.md)

## 번역 정책

- 원문 파일을 덮어쓰지 않습니다.
- 기능 이름, API path, status enum, CLI 명령은 원문 표기를 유지합니다.
- 설명 문장은 자연스러운 한국어로 번역하되, 운영자가 실제로 따라 할 수 있도록 명령과 필드명은 보존합니다.
- upstream 문서가 바뀌면 한국어 문서도 같은 구조로 갱신합니다.
