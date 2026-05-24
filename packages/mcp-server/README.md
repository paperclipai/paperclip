# Valadrien OS MCP Server

Model Context Protocol server for Valadrien OS.

This package is a thin MCP wrapper over the existing Valadrien OS REST API. It does
not talk to the database directly and it does not reimplement business logic.

## Authentication

The server reads its configuration from environment variables:

- `VALADRIEN_OS_API_URL` - Valadrien OS base URL, for example `http://localhost:3100`
- `VALADRIEN_OS_API_KEY` - bearer token used for `/api` requests
- `VALADRIEN_OS_COMPANY_ID` - optional default company for company-scoped tools
- `VALADRIEN_OS_AGENT_ID` - optional default agent for checkout helpers
- `VALADRIEN_OS_RUN_ID` - optional run id forwarded on mutating requests

## Usage

```sh
npx -y @valadrien-os/mcp-server
```

Or locally in this repo:

```sh
pnpm --filter @valadrien-os/mcp-server build
node packages/mcp-server/dist/stdio.js
```

## Tool Surface

Read tools:

- `valadrienOsMe`
- `valadrienOsInboxLite`
- `valadrienOsListAgents`
- `valadrienOsGetAgent`
- `valadrienOsListIssues`
- `valadrienOsGetIssue`
- `valadrienOsGetHeartbeatContext`
- `valadrienOsListComments`
- `valadrienOsGetComment`
- `valadrienOsListIssueApprovals`
- `valadrienOsListDocuments`
- `valadrienOsGetDocument`
- `valadrienOsListDocumentRevisions`
- `valadrienOsListProjects`
- `valadrienOsGetProject`
- `valadrienOsGetIssueWorkspaceRuntime`
- `valadrienOsWaitForIssueWorkspaceService`
- `valadrienOsListGoals`
- `valadrienOsGetGoal`
- `valadrienOsListApprovals`
- `valadrienOsGetApproval`
- `valadrienOsGetApprovalIssues`
- `valadrienOsListApprovalComments`

Write tools:

- `valadrienOsCreateIssue`
- `valadrienOsUpdateIssue`
- `valadrienOsCheckoutIssue`
- `valadrienOsReleaseIssue`
- `valadrienOsAddComment`
- `valadrienOsSuggestTasks`
- `valadrienOsAskUserQuestions`
- `valadrienOsRequestConfirmation`
- `valadrienOsUpsertIssueDocument`
- `valadrienOsRestoreIssueDocumentRevision`
- `valadrienOsControlIssueWorkspaceServices`
- `valadrienOsCreateApproval`
- `valadrienOsLinkIssueApproval`
- `valadrienOsUnlinkIssueApproval`
- `valadrienOsApprovalDecision`
- `valadrienOsAddApprovalComment`

Escape hatch:

- `valadrienOsApiRequest`

`valadrienOsApiRequest` is limited to paths under `/api` and JSON bodies. It is
meant for endpoints that do not yet have a dedicated MCP tool.
