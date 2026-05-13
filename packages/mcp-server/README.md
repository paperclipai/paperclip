# Paperclip MCP Server

Model Context Protocol server for Paperclip.

This package is a thin MCP wrapper over the existing Paperclip REST API. It does
not talk to the database directly and it does not reimplement business logic.

## Authentication

The server reads its configuration from environment variables:

- `ODYSSEUS_API_URL` - Paperclip base URL, for example `http://localhost:3100`
- `ODYSSEUS_API_KEY` - bearer token used for `/api` requests
- `ODYSSEUS_COMPANY_ID` - optional default company for company-scoped tools
- `ODYSSEUS_AGENT_ID` - optional default agent for checkout helpers
- `ODYSSEUS_RUN_ID` - optional run id forwarded on mutating requests

## Usage

```sh
npx -y @odysseus/mcp-server
```

Or locally in this repo:

```sh
pnpm --filter @odysseus/mcp-server build
node packages/mcp-server/dist/stdio.js
```

## Tool Surface

Read tools:

- `odysseusMe`
- `odysseusInboxLite`
- `odysseusListAgents`
- `odysseusGetAgent`
- `odysseusListIssues`
- `odysseusGetIssue`
- `odysseusGetHeartbeatContext`
- `odysseusListComments`
- `odysseusGetComment`
- `odysseusListIssueApprovals`
- `odysseusListDocuments`
- `odysseusGetDocument`
- `odysseusListDocumentRevisions`
- `odysseusListProjects`
- `odysseusGetProject`
- `odysseusGetIssueWorkspaceRuntime`
- `odysseusWaitForIssueWorkspaceService`
- `odysseusListGoals`
- `odysseusGetGoal`
- `odysseusListApprovals`
- `odysseusGetApproval`
- `odysseusGetApprovalIssues`
- `odysseusListApprovalComments`

Write tools:

- `odysseusCreateIssue`
- `odysseusUpdateIssue`
- `odysseusCheckoutIssue`
- `odysseusReleaseIssue`
- `odysseusAddComment`
- `odysseusSuggestTasks`
- `odysseusAskUserQuestions`
- `odysseusRequestConfirmation`
- `odysseusUpsertIssueDocument`
- `odysseusRestoreIssueDocumentRevision`
- `odysseusControlIssueWorkspaceServices`
- `odysseusCreateApproval`
- `odysseusLinkIssueApproval`
- `odysseusUnlinkIssueApproval`
- `odysseusApprovalDecision`
- `odysseusAddApprovalComment`

Escape hatch:

- `odysseusApiRequest`

`odysseusApiRequest` is limited to paths under `/api` and JSON bodies. It is
meant for endpoints that do not yet have a dedicated MCP tool.
