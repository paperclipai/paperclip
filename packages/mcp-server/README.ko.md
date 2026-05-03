# Paperclip MCP Server

Paperclip용 Model Context Protocol server입니다.

이 package는 기존 Paperclip REST API 위에 얇게 얹은 MCP wrapper입니다. database에 직접 접근하지 않고 business logic을 다시 구현하지 않습니다.

## 인증

환경 변수로 설정을 읽습니다.

| Variable | 설명 |
| --- | --- |
| `PAPERCLIP_API_URL` | Paperclip base URL, 예: `http://localhost:3100` |
| `PAPERCLIP_API_KEY` | `/api` 요청에 사용할 bearer token |
| `PAPERCLIP_COMPANY_ID` | company-scoped tool의 optional default company |
| `PAPERCLIP_AGENT_ID` | checkout helper의 optional default agent |
| `PAPERCLIP_RUN_ID` | mutating request에 전달할 optional run id |

## 사용

```sh
npx -y @paperclipai/mcp-server
```

repo 안에서 로컬 실행:

```sh
pnpm --filter @paperclipai/mcp-server build
node packages/mcp-server/dist/stdio.js
```

## Tool surface

Read tools:

- `paperclipMe`
- `paperclipInboxLite`
- `paperclipListAgents`
- `paperclipGetAgent`
- `paperclipListIssues`
- `paperclipGetIssue`
- `paperclipGetHeartbeatContext`
- `paperclipListComments`
- `paperclipGetComment`
- `paperclipListProjects`
- `paperclipGetProject`
- `paperclipListGoals`
- `paperclipGetGoal`
- `paperclipListApprovals`
- `paperclipGetApproval`

Write tools:

- `paperclipCreateIssue`
- `paperclipUpdateIssue`
- `paperclipCheckoutIssue`
- `paperclipReleaseIssue`
- `paperclipAddComment`
- `paperclipSuggestTasks`
- `paperclipAskUserQuestions`
- `paperclipRequestConfirmation`
- `paperclipCreateApproval`
- `paperclipApprovalDecision`

Escape hatch:

- `paperclipApiRequest`

`paperclipApiRequest`는 `/api` 아래 path와 JSON body로 제한됩니다. 아직 dedicated MCP tool이 없는 endpoint에 사용합니다.
