# Paperclip MCP Registry / Allowlist / Quarantine / Audit Log 우선 정책

작성일: 2026-04-28
상태: 제안(실행 전 설계)

## 배경
현재 요청은 `trusted tool` 목록에 MCP 서버를 바로 추가하는 방식의 위험을 줄이고,
Paperclip가 먼저 MCP 등록-검증-승인-감사 흐름을 통과하도록 강제하는 운영 통제면을 추가하는 것이다.

## 정책 결론
- **Do not trust-first**: MCP 서버를 바로 trusted tool로 등록/실행하지 않는다.
- **4단계 게이트**: `pending -> quarantine -> allowlist -> revoked`(혹은 disabled) 상태 전이.
- **아웃풋 제약**: allowlist가 아닌 MCP는 자동 실행/다운스트림 해제 불가.
- **감사 의무**: 등록/격리/승인/폐기에 대한 audit log 기록 + runId 보존.

## 제안 데이터 모델 (최소 단위)
- `mcp_servers`(또는 기존 plugin/adapter 메타에 통합 가능한 registry 테이블)
  - 필수 컬럼: `id`, `companyId`, `endpoint`, `transport`, `metadata`, `ownerAgentId`, `status`, `riskLevel`, `scope`, `approvedBy`, `approvedAt`, `approvedUntil`, `evidence`, `createdBy`, `createdAt`, `updatedAt`
  - 상태: `pending`, `quarantine`, `allowlist`, `revoked`, `disabled`
- `mcp_server_audit_log`
  - 필수: `id`, `companyId`, `actor`, `serverId`, `from_status`, `to_status`, `reason`, `runId`, `evidence`, `createdAt`

## 운영 규칙(Heartbeat/Gatekeeper 반영)
- 다운스트림 이슈에 MCP 의존성이 있으면 다음을 확인:
  1) MCP 서버 등록 여부
  2) 상태가 `allowlist`
  3) 만료/승인 scope 유효성
- 위 조건 미충족 시 해당 이슈는 기본 `blocked` 처리 후 작업 중단
- 승인 사유가 빈약한 경우: blocker 코멘트에 명확한 `누가/무엇을/언제` 기입 필요

## 구현 단계
1. **스키마 정의**: `mcp_servers`, `mcp_server_audit_log` 추가.
2. **Registry API**:
   - 생성(등록): 승인 전 상태 `pending`
   - 점검/격리/승인/폐기 전이 API
   - `allowlist` 상태 조회 API(플러그인/runner 조회 시 사용)
3. **엔드포인트 통합**: tool 실행 전 MCP 상태 확인 훅 삽입
   - 비허용 상태면 실행 거부 + 명시적 error code
4. **SKILL/AGENTS 반영**: 현재 요청사항대로 heartbeat에서 선행 체크 우선화
5. **감사 로그 대시보드/쿼리**: runId 기준 추적
6. **테스트/마이그레이션**: 마이그레이션 + 상태 전이 단위 테스트 + Heartbeat 차단 케이스 통합 테스트

## 수용 기준
- MCP 서버를 등록만 했고 allowlist 안 된 상태에서는 자동 실행/dispatch되지 않아야 함
- `pending`/`quarantine` 상태 이슈가 있을 때 downsteam 실행이 block 되며, blocked 코멘트가 남아야 함
- 상태 전이 1건당 audit log 1건 이상 생성
- 변경 후 운영자에게 `runId`, `serverId`, `from/to`, `actor`, `evidence`가 조회 가능해야 함
