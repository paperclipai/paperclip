---
name: paperclip-create-agent-ko
description: >
  Paperclip에서 새 에이전트를 만들거나 채용 요청을 제출하는 절차의 한국어 안내입니다.
---

# Paperclip 에이전트 생성 스킬 한국어 안내

이 문서는 `paperclip-create-agent` 스킬의 한국어 안내입니다. 실제 실행 계약은 원문 `SKILL.md`가 기준입니다.

## 전제 조건

다음 중 하나가 필요합니다.

- board access
- 회사 내 `can_create_agents=true` 권한

권한이 없으면 CEO 또는 board에 escalation합니다.

## 작업 흐름

### 1. 정체성과 회사 확인

```sh
curl -sS "$PAPERCLIP_API_URL/api/agents/me" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"
```

### 2. 어댑터 설정 확인

현재 인스턴스가 어떤 에이전트 설정을 지원하는지 확인합니다.

```sh
curl -sS "$PAPERCLIP_API_URL/llms/agent-configuration.txt" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"
```

특정 어댑터를 쓸 계획이면 해당 설정도 확인합니다.

```sh
curl -sS "$PAPERCLIP_API_URL/llms/agent-configuration/claude_local.txt" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"
```

### 3. 기존 에이전트 설정 비교

```sh
curl -sS "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/agent-configurations" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"
```

회사 안의 naming, icon, reporting line, adapter convention을 맞춥니다.

### 4. instructions source 선택

채용 품질에서 가장 중요한 결정입니다. 다음 중 하나를 선택합니다.

- **Exact template**: 역할과 정확히 맞는 template 사용
- **Adjacent template**: 가까운 template을 복사해 역할에 맞게 수정
- **Generic fallback**: template이 없으면 baseline role guide로 새 `AGENTS.md` 작성

사용한 경로를 hire-request comment에 적어 board가 판단할 수 있게 합니다.

### 5. 아이콘 확인

```sh
curl -sS "$PAPERCLIP_API_URL/llms/agent-icons.txt" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"
```

### 6. 채용 설정 작성

다음을 명확히 작성합니다.

- name, role, title
- icon
- reportsTo
- adapter type/config
- desiredSkills
- capabilities
- instructions bundle (`AGENTS.md`)
- runtimeConfig
- sourceIssueId 또는 sourceIssueIds

새 에이전트는 기본적으로 timer heartbeat를 꺼둡니다. 반복 작업이 필요한 역할이거나 사용자가 명시적으로 요청한 경우에만 켭니다.

coding/execution 에이전트에는 Paperclip 실행 계약을 포함합니다.

- 같은 하트비트에서 실제 작업 시작
- planning만 하고 멈추지 않기
- durable progress 남기기
- 긴 작업은 child issue로 분리
- blocked 상태에는 owner/action 명시
- budget, approval gate, company boundary 준수

### 7. 제출 전 체크

원문 checklist를 끝까지 확인합니다.

```text
skills/paperclip-create-agent/references/draft-review-checklist.md
```

### 8. 채용 요청 제출

```sh
curl -sS -X POST "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/agent-hires" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ ... }'
```

응답에 `approval`이 있으면 채용은 `pending_approval` 상태입니다.

### 9. 승인 이후 처리

보드가 승인하면 `PAPERCLIP_APPROVAL_ID`로 wake됩니다. approval과 연결 이슈를 읽고, 요청이 해결되었으면 이슈를 닫거나 다음 행동을 댓글로 남깁니다.

## 참고 문서

- `agent-instruction-templates.md`
- `baseline-role-guide.md`
- `draft-review-checklist.md`
- `api-reference.md`
