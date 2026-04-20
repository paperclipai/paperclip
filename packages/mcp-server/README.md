# Paperclip MCP Server

Model Context Protocol server for Paperclip.

This package is a thin MCP wrapper over the existing Paperclip REST API. It does
not talk to the database directly and it does not reimplement business logic.

## Authentication

The server reads its configuration from environment variables:

- `AITEAMCORP_API_URL` - Paperclip base URL, for example `http://localhost:3100`
- `AITEAMCORP_API_KEY` - bearer token used for `/api` requests
- `AITEAMCORP_COMPANY_ID` - optional default company for company-scoped tools
- `AITEAMCORP_AGENT_ID` - optional default agent for checkout helpers
- `AITEAMCORP_RUN_ID` - optional run id forwarded on mutating requests

## Usage

```sh
npx -y @aiteamcorp/mcp-server
```

Or locally in this repo:

```sh
pnpm --filter @aiteamcorp/mcp-server build
node packages/mcp-server/dist/stdio.js
```

## Tool Surface

Read tools:

- `aiteamcorpMe`
- `aiteamcorpInboxLite`
- `aiteamcorpListAgents`
- `aiteamcorpGetAgent`
- `aiteamcorpListIssues`
- `aiteamcorpGetIssue`
- `aiteamcorpGetHeartbeatContext`
- `aiteamcorpListComments`
- `aiteamcorpGetComment`
- `aiteamcorpListIssueApprovals`
- `aiteamcorpListDocuments`
- `aiteamcorpGetDocument`
- `aiteamcorpListDocumentRevisions`
- `aiteamcorpListProjects`
- `aiteamcorpGetProject`
- `aiteamcorpListGoals`
- `aiteamcorpGetGoal`
- `aiteamcorpListApprovals`
- `aiteamcorpGetApproval`
- `aiteamcorpGetApprovalIssues`
- `aiteamcorpListApprovalComments`

Write tools:

- `aiteamcorpCreateIssue`
- `aiteamcorpUpdateIssue`
- `aiteamcorpCheckoutIssue`
- `aiteamcorpReleaseIssue`
- `aiteamcorpAddComment`
- `aiteamcorpUpsertIssueDocument`
- `aiteamcorpRestoreIssueDocumentRevision`
- `aiteamcorpCreateApproval`
- `aiteamcorpLinkIssueApproval`
- `aiteamcorpUnlinkIssueApproval`
- `aiteamcorpApprovalDecision`
- `aiteamcorpAddApprovalComment`

Escape hatch:

- `aiteamcorpApiRequest`

`aiteamcorpApiRequest` is limited to paths under `/api` and JSON bodies. It is
meant for endpoints that do not yet have a dedicated MCP tool.
