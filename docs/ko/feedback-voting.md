# Feedback Voting

agent response에 **Helpful** 또는 **Needs work**를 누르면 Paperclip은 vote를 로컬 instance 옆에 저장합니다. 이 문서는 저장되는 데이터, 조회 방법, export 방법을 설명합니다.

## 동작 방식

1. agent comment 또는 document revision에서 Helpful/Needs work를 클릭합니다.
2. Needs work라면 개선 이유를 선택적으로 입력할 수 있습니다.
3. consent dialog에서 local only 또는 share를 선택합니다. 선택은 다음 vote에도 기억됩니다.

## 저장되는 것

| Record | 내용 |
| --- | --- |
| Vote | up/down vote, optional reason, sharing preference, consent version, timestamp |
| Trace bundle | voted target text, issue title, agent info, vote, reason 등 context snapshot |

모든 데이터는 local Paperclip database에 저장됩니다. 명시적으로 share를 선택하지 않으면 machine 밖으로 나가지 않습니다.

## CLI report

```sh
pnpm paperclipai feedback report
```

다른 server/company:

```sh
pnpm paperclipai feedback report --api-base http://127.0.0.1:3000 --company-id <company-id>
```

## API

```sh
curl http://127.0.0.1:3102/api/issues/<issueId>/feedback-votes
curl 'http://127.0.0.1:3102/api/issues/<issueId>/feedback-traces?includePayload=true'
curl 'http://127.0.0.1:3102/api/companies/<companyId>/feedback-traces?includePayload=true'
curl http://127.0.0.1:3102/api/feedback-traces/<traceId>
curl http://127.0.0.1:3102/api/feedback-traces/<traceId>/bundle
```

필터:

- `vote=up|down`
- `status=local_only|pending|sent|failed`
- `targetType=issue_comment|issue_document_revision`
- `sharedOnly=true`
- `includePayload=true`
- `from` / `to`

## Export

```sh
pnpm paperclipai feedback export
```

timestamped directory와 zip을 생성합니다. `votes/`, `traces/`, `full-traces/`에 metadata와 full context bundle이 저장됩니다.
